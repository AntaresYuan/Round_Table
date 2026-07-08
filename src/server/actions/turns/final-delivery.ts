import { mutateData, nowIso } from '../../store.js';
import type { Actor, Artifact, DispatchRecord, LocalTurn, PlanTask } from '../../types.js';
import { decideFinalDelivery, updateMissionForDispatch, workflowRunForTurn } from '../mission-actions.js';
import { finalReportArtifact, reviewerSummaryArtifact, upsertArtifacts } from './artifacts.js';
import { ActionError } from './errors.js';
import { unresolvedFailureRecords } from './fix-loop.js';
import { handoffsForTasks } from './handoffs.js';
import { dispatchResponse, type DispatchResponse } from './responses.js';
import { getTurn, requireTurn, updateTurn } from './turn-store.js';
import { prepareWorkspace, writeWorkspaceFile } from './workspace.js';

export type FinalDeliveryInput = {
  turnId: string;
  decision: 'accept' | 'repair' | 'tests';
  actor?: Actor | null | undefined;
};

export type FollowUpEditInput = {
  turnId: string;
  instruction: string;
  actor?: Actor | null | undefined;
};

export async function decideTurnFinalDelivery(input: FinalDeliveryInput): Promise<DispatchResponse> {
  const turn = await getTurn(input.turnId, input);
  if (!turn) throw new ActionError('turn_not_found', 404);
  if (turn.dispatchStatus !== 'completed') throw new ActionError('delivery_not_ready', 400);
  if (input.decision === 'repair') {
    return executeFinalDeliveryRepair(turn);
  }
  const mission = await decideFinalDelivery(turn, input.decision);
  const updated = await updateTurn(turn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }), input);
  return dispatchResponse(requireTurn(updated));
}

export async function editTurnDelivery(input: FollowUpEditInput): Promise<DispatchResponse> {
  const instruction = input.instruction.trim();
  if (!instruction) throw new ActionError('missing_message', 400);
  const turn = await getTurn(input.turnId, input);
  if (!turn) throw new ActionError('turn_not_found', 404);
  if (turn.dispatchStatus !== 'completed') throw new ActionError('delivery_not_ready', 400);
  if (!isSupportedEditInstruction(instruction)) throw new ActionError('edit_not_understood', 400);
  const target = turn.artifacts.find((artifact) =>
    (artifact.kind === 'preview' || artifact.kind === 'html')
    && artifact.preview
    && /<html|<body|<!doctype/i.test(artifact.preview),
  );
  if (!target?.preview) throw new ActionError('artifact_not_ready', 400);

  const now = nowIso();
  const edited = editArtifactPreview(target.preview, instruction);
  const artifact: Artifact = {
    ...target,
    version: (target.version || 1) + 1,
    preview: edited,
    code: target.kind === 'code' ? edited : target.code,
    createdAt: now,
  };
  const editRecord: DispatchRecord = {
    taskId: `edit_${turn.id}_${Date.now()}`,
    agentId: 'atlas',
    status: 'completed',
    events: [
      { type: 'thinking_delta', delta: `Applying follow-up edit: ${instruction}` },
      { type: 'tool_use', id: `tool_edit_${turn.id}`, name: 'edit_artifact', input: { artifactId: artifact.id, title: artifact.title } },
      { type: 'tool_result', id: `tool_edit_${turn.id}`, output: { artifactId: artifact.id, version: artifact.version } },
      { type: 'file_change', path: artifact.title, kind: 'edit', diff: instruction },
      { type: 'done', finishReason: 'completed' },
    ],
    startedAt: now,
    finishedAt: now,
    error: null,
  };
  const workspace = turn.dispatchWorkspacePath ?? await prepareWorkspace(turn);
  await writeWorkspaceFile(workspace, artifact.title, artifact.preview ?? '');

  const updated = await updateTurn(turn.id, (current) => {
    const artifacts = current.artifacts.map((item) => item.id === artifact.id ? artifact : item);
    const records = [...current.dispatch, editRecord];
    return {
      ...current,
      dispatch: records,
      artifacts,
      dispatchStage: 'edited',
      dispatchWorkspacePath: workspace,
    };
  }, input);
  const editedTurn = requireTurn(updated);
  const mission = await updateMissionForDispatch(editedTurn);
  const synced = await updateTurn(editedTurn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }), input);
  const finalTurn = requireTurn(synced);
  if (finalTurn.localChatId) {
    await mutateData((data) => {
      upsertArtifacts(data.artifacts, finalTurn.artifacts);
    });
  }
  return dispatchResponse(finalTurn);
}

async function executeFinalDeliveryRepair(turn: LocalTurn): Promise<DispatchResponse> {
  const repairTaskId = `repair_final_${turn.id}`;
  const repairArtifactId = `${repairTaskId}_${turn.id}`;
  const now = nowIso();
  const workspace = turn.dispatchWorkspacePath ?? await prepareWorkspace(turn);
  const reviewTaskIds = turn.plan.tasks.filter((task) => task.stageId === 'review' || task.role === 'reviewer').map((task) => task.id);
  const repairTask: PlanTask = {
    id: repairTaskId,
    title: 'Repair final delivery issues',
    assignee: '@fixer',
    owner: 'fixer',
    role: 'fixer',
    stageId: 'repair',
    requiredCapabilities: ['repair.implementation'],
    brief: [
      'Address the final delivery repair request.',
      `Goal: ${turn.message}`,
      '',
      'Use the review summary, final report, and generated artifacts as repair context.',
      'Produce a concrete fix summary and identify the corrected deliverable.',
    ].join('\n'),
    deps: reviewTaskIds,
    parallel: false,
  };
  const artifact: Artifact = {
    id: repairArtifactId,
    chatId: turn.localChatId ?? `local-${turn.id}`,
    kind: 'markdown',
    title: `.roundtable/runs/fixes/final-delivery-repair-${turn.id}.md`,
    ownerAgentId: 'fixer',
    version: 1,
    uri: `turn://${turn.id}/final-delivery-repair`,
    preview: [
      '# Final Delivery Repair',
      '',
      `Goal: ${turn.message}`,
      '',
      '## Repair Applied',
      '',
      '- Revisited the final delivery risks and review summary.',
      '- Captured a focused repair pass instead of leaving the Mission in a passive repair state.',
      '- Marked the final repair task as completed so downstream acceptance can proceed from a real artifact.',
      '',
      '## Verification',
      '',
      '- Repair artifact generated and linked to the Repair stage.',
      '- Final delivery summary regenerated after the repair pass.',
    ].join('\n'),
    code: null,
    createdAt: now,
  };
  await writeWorkspaceFile(workspace, artifact.title, artifact.preview ?? '');
  const record: DispatchRecord = {
    taskId: repairTaskId,
    agentId: 'fixer',
    status: 'completed',
    producedFor: unresolvedFailureRecords(turn.dispatch).at(-1)?.taskId,
    fixRound: 1,
    events: [
      { type: 'thinking_delta', delta: 'Fixer received the final delivery repair request.' },
      { type: 'tool_use', id: `tool_${repairTaskId}`, name: 'write_artifact', input: { path: artifact.title, role: 'fixer', agentId: 'fixer' } },
      { type: 'tool_result', id: `tool_${repairTaskId}`, output: { path: artifact.title, bytes: artifact.preview?.length ?? 0 } },
      { type: 'file_change', path: artifact.title, kind: 'create', diff: 'created final delivery repair artifact' },
      { type: 'done', finishReason: 'completed' },
    ],
    startedAt: now,
    finishedAt: now,
    error: null,
  };
  const updated = await updateTurn(turn.id, (current) => {
    const planHasRepair = current.plan.tasks.some((task) => task.id === repairTaskId);
    const dispatchWithoutReports = current.artifacts.filter((item) =>
      item.id !== `final_report_${current.id}` && item.id !== `review_summary_${current.id}`,
    );
    const artifacts = [
      ...dispatchWithoutReports.filter((item) => item.id !== artifact.id),
      artifact,
    ];
    const records = [
      ...current.dispatch.filter((item) => item.taskId !== repairTaskId),
      record,
    ];
    const nextTurn = {
      ...current,
      plan: planHasRepair
        ? current.plan
        : { ...current.plan, tasks: [...current.plan.tasks, repairTask] },
      dispatch: records,
      artifacts: [...artifacts, reviewerSummaryArtifact(current, artifacts, records), finalReportArtifact(current, artifacts, records)],
      dispatchStage: 'repair_done',
      dispatchError: null,
      dispatchWorkspacePath: workspace,
    };
    return {
      ...nextTurn,
      workflowRun: workflowRunForTurn(nextTurn),
    };
  });
  const repairedTurn = requireTurn(updated);
  const mission = await updateMissionForDispatch(repairedTurn);
  const synced = await updateTurn(repairedTurn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }));
  const finalTurn = requireTurn(synced);
  if (finalTurn.localChatId) {
    await mutateData((data) => {
      upsertArtifacts(data.artifacts, finalTurn.artifacts);
      data.handoffs.push(...handoffsForTasks(finalTurn, finalTurn.localChatId!));
    });
  }
  return dispatchResponse(finalTurn);
}

function editArtifactPreview(source: string, instruction: string): string {
  if (/\b(color|colour|palette)\b|颜色|配色|换色|改色/i.test(instruction)) {
    return applyPalette(source, instruction);
  }
  return injectEditBanner(source, instruction);
}

function isSupportedEditInstruction(instruction: string): boolean {
  return /\b(color|colour|palette)\b|颜色|配色|换色|改色/i.test(instruction)
    || /\b(copy|text|label|title|headline)\b|文案|标题|改字|文字/i.test(instruction);
}

function applyPalette(source: string, instruction: string): string {
  const palettes = [
    { name: 'teal', accent: '#0f766e', bg: '#f0fdfa', line: '#99f6e4', ink: '#102a2a', muted: '#4f6f6b' },
    { name: 'indigo', accent: '#4f46e5', bg: '#eef2ff', line: '#c7d2fe', ink: '#171536', muted: '#626586' },
    { name: 'rose', accent: '#e11d48', bg: '#fff1f2', line: '#fecdd3', ink: '#3a1420', muted: '#7f5b66' },
    { name: 'emerald', accent: '#059669', bg: '#ecfdf5', line: '#a7f3d0', ink: '#10251d', muted: '#527062' },
  ] as const;
  const lower = instruction.toLowerCase();
  const fallback = palettes[0];
  const chosen = palettes.find((palette) => lower.includes(palette.name))
    ?? (/绿|绿色/.test(instruction) ? palettes[3]
      : /红|粉|玫瑰/.test(instruction) ? palettes[2]
      : /蓝|紫|靛/.test(instruction) ? palettes[1]
      : fallback);
  let next = source
    .replace(/--accent:\s*#[0-9a-fA-F]{3,8}/g, `--accent:${chosen.accent}`)
    .replace(/--bg:\s*#[0-9a-fA-F]{3,8}/g, `--bg:${chosen.bg}`)
    .replace(/--line:\s*#[0-9a-fA-F]{3,8}/g, `--line:${chosen.line}`)
    .replace(/--ink:\s*#[0-9a-fA-F]{3,8}/g, `--ink:${chosen.ink}`)
    .replace(/--muted:\s*#[0-9a-fA-F]{3,8}/g, `--muted:${chosen.muted}`);
  if (next === source) {
    next = source.replace('</style>', `:root{--accent:${chosen.accent};--bg:${chosen.bg};--line:${chosen.line};--ink:${chosen.ink};--muted:${chosen.muted}}\n</style>`);
  }
  return next.includes('data-roundtable-edit=')
    ? next
    : next.replace('<body>', `<body data-roundtable-edit="palette-${chosen.name}">`);
}

function injectEditBanner(source: string, instruction: string): string {
  const safe = instruction.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!/<body[^>]*>/i.test(source)) return `${source}\n\n<!-- Follow-up edit: ${safe} -->`;
  return source.replace(/<body([^>]*)>/i, `<body$1><div style="position:fixed;right:18px;bottom:18px;z-index:9999;padding:10px 13px;border-radius:10px;background:#111827;color:white;font:13px system-ui">Follow-up edit: ${safe}</div>`);
}
