import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { id, mutateData, nowIso, readData } from '../store.js';
import type {
  Actor,
  AgentEvent,
  Artifact,
  DispatchRecord,
  Handoff,
  Intake,
  LocalTurn,
  Plan,
  PlanTask,
  WorkflowRun,
} from '../types.js';
import { runAgentTask, normalizeAdapter } from './agent-runner.js';
import { E2BUnavailableError } from './adapters/e2b-adapter.js';
import {
  runScheduler,
  type ScheduledTask,
  type TaskResult,
} from './scheduler.js';
import { describeFindings, hasBlockingFinding, safetyEnabled, scanArtifact, type SafetyFinding } from './safety.js';
import { AGENT_ROSTER, mentionedAgents, mentionTokens, messageWithoutMentions, type AgentProfile } from './agent-roster.js';

export type CreateTurnInput = {
  message: string;
  turnId?: string | undefined;
  chatId?: string | undefined;
  actor?: Actor | null | undefined;
};

export type ApprovalInput = {
  turnId: string;
  decision: 'approve' | 'reject';
  autoDispatch?: boolean | undefined;
  agentAdapter?: string | undefined;
};

export type DispatchInput = {
  turnId: string;
  agentAdapter?: string | undefined;
};

export async function createTurn(input: CreateTurnInput): Promise<TurnResponse> {
  const message = input.message.trim();
  if (!message) throw new ActionError('missing_message', 400);
  const turnId = input.turnId?.trim() || id('turn');
  const chatId = input.chatId?.trim() || null;
  const intake = intakeFromMessage(message);
  const plan = planFromMessage(message);
  const artifacts = baseArtifacts(turnId, chatId ?? `local-${turnId}`, message, intake, plan);
  const now = nowIso();
  const turn: LocalTurn = {
    id: turnId,
    localChatId: chatId,
    ownerId: input.actor?.id ?? null,
    message,
    status: 'done',
    createdAt: now,
    provider: 'roundtable-local',
    model: 'agent-chain-v1',
    pmMessage: `Starting ${plan.tasks.length} agent step${plan.tasks.length === 1 ? '' : 's'}.`,
    needsApproval: false,
    approvalStatus: 'approved',
    approvedAt: now,
    dispatchStatus: 'not_started',
    dispatchAdapter: null,
    dispatchedAt: null,
    dispatchStage: 'queued',
    dispatchError: null,
    dispatchWorkspacePath: null,
    dispatch: [],
    artifacts,
    intake,
    plan,
    workflow: null,
    workflowRun: null,
    error: null,
  };

  await mutateData((data) => {
    data.turns = [turn, ...data.turns.filter((item) => item.id !== turnId)];
    if (chatId) {
      upsertArtifacts(data.artifacts, artifacts);
      data.handoffs.push(handoffForTurn(input.actor, chatId, turn));
    }
  });

  return turnResponse(turn);
}

export async function listTurns(chatId?: string | undefined): Promise<LocalTurn[]> {
  return mutateData((data) =>
    data.turns
      .filter((turn) => !chatId || turn.localChatId === chatId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

export async function getTurn(turnId: string): Promise<LocalTurn | null> {
  return mutateData((data) => data.turns.find((turn) => turn.id === turnId) ?? null);
}

export async function approveTurn(input: ApprovalInput): Promise<DispatchResponse> {
  const turn = await getTurn(input.turnId);
  if (!turn) throw new ActionError('turn_not_found', 404);
  if (input.decision === 'reject') {
    const rejected = await updateTurn(input.turnId, (current) => ({
      ...current,
      needsApproval: true,
      approvalStatus: 'rejected',
      dispatchStatus: 'failed',
      dispatchStage: 'rejected',
      dispatchError: 'rejected_by_user',
    }));
    return dispatchResponse(requireTurn(rejected));
  }

  const approved = await updateTurn(input.turnId, (current) => ({
    ...current,
    needsApproval: false,
    approvalStatus: 'approved',
    approvedAt: nowIso(),
    dispatchStage: 'approved',
  }));
  const next = requireTurn(approved);
  if (input.autoDispatch) {
    return dispatchTurn({ turnId: next.id, agentAdapter: input.agentAdapter });
  }
  return dispatchResponse(next);
}

export async function dispatchTurn(input: DispatchInput): Promise<DispatchResponse> {
  const turn = await getTurn(input.turnId);
  if (!turn) throw new ActionError('turn_not_found', 404);
  if (turn.dispatchStatus === 'completed' && turn.dispatch.length > 0) return dispatchResponse(turn);

  const adapter = normalizeAdapter(input.agentAdapter);
  const workspace = await prepareWorkspace(turn);
  await updateTurn(turn.id, (current) => ({
    ...current,
    dispatchStatus: 'running',
    dispatchAdapter: adapter,
    dispatchStage: 'dispatch',
    dispatchError: null,
    dispatchWorkspacePath: workspace,
  }));

  // Per-task side data the scheduler's lean TaskResult doesn't carry: the agent
  // event stream and the produced artifact, keyed by task id for later assembly.
  const eventsByTask = new Map<string, AgentEvent[]>();
  const artifactByTask = new Map<string, Artifact>();

  const runTask = async (
    task: PlanTask,
    depOutputs: Record<string, { summary: string }>,
  ): Promise<TaskResult> => {
    const handoffContext = Object.entries(depOutputs)
      .map(([depId, out]) => `## from ${depId}\n\n${out.summary}`)
      .join('\n\n---\n\n') || undefined;

    let result;
    try {
      result = await runAgentTask({ adapter, workspace, task, message: turn.message, handoffContext });
    } catch (error) {
      // E2B opt-in: if the sandbox is unavailable, fall back to local-dispatch in
      // this layer (not silently inside the adapter) so a misconfig is logged but
      // the run still completes.
      if (error instanceof E2BUnavailableError) {
        console.warn(`E2B unavailable, falling back to local-dispatch for ${task.id}: ${error.message}`);
        result = await runAgentTask({ adapter: 'local-dispatch', workspace, task, message: turn.message, handoffContext });
      } else {
        throw error;
      }
    }

    eventsByTask.set(task.id, result.events);
    artifactByTask.set(task.id, artifactFromRun(turn, task, result));

    if (!result.ok) {
      return { ok: false, error: { message: result.error ?? 'agent_task_failed' } };
    }

    // Safety gate: a high-severity finding turns this task into an error, which
    // the scheduler routes into the bounded review→fix loop via onFailure.
    if (safetyEnabled()) {
      const findings = scanArtifact(result.text);
      if (hasBlockingFinding(findings)) {
        return { ok: false, error: { message: 'safety_block', scan: findings } };
      }
    }

    return { ok: true, output: { summary: result.text, artifactId: artifactByTask.get(task.id)?.id } };
  };

  const run = await runScheduler({
    tasks: turn.plan.tasks,
    runTask,
    maxFixRounds: maxFixRounds(),
    now: nowIso,
    onFailure: (failed, error) => makeFixerTask(failed, error),
  });

  // Assemble DispatchRecords from scheduler records, enriching with the captured
  // agent events. Blocked tasks carry no events.
  const records: DispatchRecord[] = run.records.map((record) => ({
    taskId: record.taskId,
    agentId: record.agentId,
    status: record.status,
    events: eventsByTask.get(record.taskId) ?? [],
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    ...(record.producedFor !== undefined ? { producedFor: record.producedFor } : {}),
    ...(record.fixRound !== undefined ? { fixRound: record.fixRound } : {}),
  }));

  const artifacts: Artifact[] = [
    ...turn.artifacts,
    ...run.tasks
      .map((task) => artifactByTask.get(task.id))
      .filter((artifact): artifact is Artifact => artifact !== undefined),
  ];

  // The run failed only if a task ended failed/blocked with no successful repair.
  const failed = run.tasks.some((task) => task.status === 'failed' || task.status === 'blocked');
  const workflowRun = workflowRunFromTasks(run.tasks);
  const completed = await updateTurn(turn.id, (current) => ({
    ...current,
    dispatchStatus: failed ? 'failed' : 'completed',
    dispatchAdapter: adapter,
    dispatchedAt: nowIso(),
    dispatchStage: failed ? 'failed' : 'done',
    dispatchError: failed ? 'one_or_more_tasks_failed' : null,
    dispatchWorkspacePath: workspace,
    dispatch: records,
    artifacts,
    workflowRun,
  }));
  const finalTurn = requireTurn(completed);
  if (finalTurn.localChatId) {
    await mutateData((data) => {
      upsertArtifacts(data.artifacts, finalTurn.artifacts);
    });
  }
  return dispatchResponse(finalTurn);
}

export async function interruptTurn(turnId: string): Promise<DispatchResponse> {
  const turn = await updateTurn(turnId, (current) => ({
    ...current,
    dispatchStatus: 'failed',
    dispatchStage: 'interrupted',
    dispatchError: 'interrupted_by_user',
  }));
  return dispatchResponse(requireTurn(turn));
}

export type TurnResponse = ReturnType<typeof turnResponse>;
export type DispatchResponse = ReturnType<typeof dispatchResponse>;

function turnResponse(turn: LocalTurn) {
  return {
    ok: true,
    id: turn.id,
    provider: turn.provider,
    model: turn.model,
    pmMessage: turn.pmMessage,
    needsApproval: turn.needsApproval,
    approvalStatus: turn.approvalStatus,
    dispatchStatus: turn.dispatchStatus,
    artifacts: turn.artifacts,
    intake: turn.intake,
    plan: turn.plan,
    workflow: turn.workflow,
    workflowRun: turn.workflowRun,
  };
}

function dispatchResponse(turn: LocalTurn) {
  return {
    ok: true,
    id: turn.id,
    needsApproval: turn.needsApproval,
    approvalStatus: turn.approvalStatus,
    approvedAt: turn.approvedAt,
    dispatchStatus: turn.dispatchStatus,
    dispatchAdapter: turn.dispatchAdapter,
    dispatchedAt: turn.dispatchedAt,
    dispatchStage: turn.dispatchStage,
    dispatchError: turn.dispatchError,
    workspacePath: turn.dispatchWorkspacePath,
    records: turn.dispatch,
    artifacts: turn.artifacts,
    workflowRun: turn.workflowRun,
  };
}

async function updateTurn(
  turnId: string,
  update: (turn: LocalTurn) => LocalTurn,
): Promise<LocalTurn | null> {
  return mutateData((data) => {
    const index = data.turns.findIndex((turn) => turn.id === turnId);
    if (index === -1) return null;
    const current = data.turns[index];
    if (!current) return null;
    const next = update(current);
    data.turns[index] = next;
    return next;
  });
}

function requireTurn(turn: LocalTurn | null): LocalTurn {
  if (!turn) throw new ActionError('turn_not_found', 404);
  return turn;
}

function intakeFromMessage(message: string): Intake {
  const lower = message.toLowerCase();
  const intentType = lower.includes('review')
    ? 'review'
    : lower.includes('fix') || lower.includes('bug')
      ? 'fix'
      : lower.includes('research')
        ? 'research'
        : 'build';
  return {
    intentType,
    summary: message.slice(0, 220),
    clarity: message.length > 24 ? 'high' : 'medium',
    risk: lower.includes('payment') || lower.includes('auth') ? 'high' : 'medium',
  };
}

function planFromMessage(message: string): Plan {
  const goal = messageWithoutMentions(message) || message;
  const base = compactTitle(goal);
  const hasExplicitMention = mentionTokens(message).length > 0;
  const targets = mentionedAgents(message);
  const explicitPlanningOnly = targets.length === 1 && targets[0]?.role === 'planner';
  const startsWithPlanning = targets.some((agent) => agent.role === 'planner') || targets.length === AGENT_ROSTER.length;
  const tasks: PlanTask[] = [];

  if (!hasExplicitMention) {
    const implementer = implementerForMessage(message);
    const reviewerAgent = reviewer();
    return {
      summary: `Plan for: ${base}`,
      tasks: [
        taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false),
        taskForAgent(`task_${implementer.id}`, titleForAgent(implementer, base), implementer, goal, ['task_planning'], false),
        taskForAgent(`task_${reviewerAgent.id}`, titleForAgent(reviewerAgent, base), reviewerAgent, goal, [`task_${implementer.id}`], false),
      ],
    };
  }

  if (startsWithPlanning || explicitPlanningOnly) {
    tasks.push(taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false));
  }

  if (!explicitPlanningOnly) {
    let previousTaskId = startsWithPlanning ? 'task_planning' : null;
    for (const agent of targets.filter((target) => target.role !== 'planner')) {
      const idValue = `task_${agent.id}`;
      tasks.push(taskForAgent(
        idValue,
        titleForAgent(agent, base),
        agent,
        goal,
        previousTaskId ? [previousTaskId] : [],
        false,
      ));
      previousTaskId = idValue;
    }
  }

  return {
    summary: `Plan for: ${base}`,
    tasks: tasks.length > 0 ? tasks : [taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false)],
  };
}

function taskForAgent(
  idValue: string,
  title: string,
  agent: AgentProfile,
  message: string,
  deps: string[],
  parallel: boolean,
): PlanTask {
  return {
    id: idValue,
    title,
    assignee: agent.assignee,
    owner: agent.id,
    role: agent.role,
    brief: `${title}. Agent: ${agent.displayName}. Role: ${agent.role}. User request: ${message}`,
    deps,
    parallel,
  };
}

function planner(): AgentProfile {
  return AGENT_ROSTER.find((agent) => agent.role === 'planner') ?? AGENT_ROSTER[0]!;
}

function reviewer(): AgentProfile {
  return AGENT_ROSTER.find((agent) => agent.role === 'reviewer') ?? planner();
}

function implementerForMessage(message: string): AgentProfile {
  const lower = message.toLowerCase();
  const wantsBackend = /\b(api|backend|server|database|db|auth|login|endpoint|接口|后端|数据库|登录|鉴权)\b/i.test(lower);
  const preferredId = wantsBackend ? 'beam' : 'atlas';
  return AGENT_ROSTER.find((agent) => agent.id === preferredId)
    ?? AGENT_ROSTER.find((agent) => agent.role === 'implementer')
    ?? planner();
}

function titleForAgent(agent: AgentProfile, base: string): string {
  if (agent.role === 'pm') return `Define product brief for ${base}`;
  if (agent.role === 'architect') return `Design architecture for ${base}`;
  if (agent.role === 'implementer') return `Build ${base} (${agent.displayName})`;
  if (agent.role === 'reviewer') return `Review ${base}`;
  if (agent.role === 'fixer') return `Fix issues for ${base}`;
  return `Plan ${base}`;
}

function baseArtifacts(
  turnId: string,
  chatId: string,
  message: string,
  intake: Intake,
  plan: Plan,
): Artifact[] {
  const createdAt = nowIso();
  return [
    {
      id: `intake_${turnId}`,
      chatId,
      kind: 'markdown',
      title: `intake/${turnId}.md`,
      ownerAgentId: 'orchestrator',
      version: 1,
      uri: `turn://${turnId}/intake`,
      preview: `# Intake\n\n${message}\n\nIntent: ${intake.intentType}\nRisk: ${intake.risk}\n`,
      code: null,
      createdAt,
    },
    {
      id: `plan_${turnId}`,
      chatId,
      kind: 'code',
      title: `plans/${turnId}.json`,
      ownerAgentId: 'orchestrator',
      version: 1,
      uri: `turn://${turnId}/plan`,
      preview: JSON.stringify(plan, null, 2),
      code: JSON.stringify(plan, null, 2),
      createdAt,
    },
  ];
}

function artifactFromRun(
  turn: LocalTurn,
  task: PlanTask,
  result: { text: string; path: string; kind: Artifact['kind'] },
): Artifact {
  return {
    id: `${task.id}_${turn.id}`,
    chatId: turn.localChatId ?? `local-${turn.id}`,
    kind: result.kind,
    title: result.path,
    ownerAgentId: task.owner ?? task.assignee.replace('@', ''),
    version: 1,
    uri: `workspace://${result.path}`,
    preview: result.text,
    code: result.kind === 'code' ? result.text : null,
    createdAt: nowIso(),
  };
}

async function prepareWorkspace(turn: LocalTurn): Promise<string> {
  const projectWorkspace = await workspaceFromChat(turn.localChatId);
  if (projectWorkspace) {
    await mkdir(projectWorkspace, { recursive: true });
    return projectWorkspace;
  }
  const root = resolve(process.env.ROUNDTABLE_WORKSPACE_ROOT || '.roundtable/workspaces');
  const workspace = resolve(root, turn.localChatId ?? turn.id);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function workspaceFromChat(chatId: string | null): Promise<string | null> {
  if (!chatId) return null;
  const data = await readData();
  const chat = data.chats.find((item) => item.id === chatId);
  if (!chat) return null;
  const workbench = data.workbenches.find((item) => item.id === chat.workbenchId);
  if (!workbench?.workspacePath) return null;
  return resolve(workbench.workspacePath);
}

// Map the scheduler's per-task status onto the WorkflowRun shape the UI reads.
function workflowRunFromTasks(tasks: ScheduledTask[]): WorkflowRun {
  const map: Record<string, 'pending' | 'running' | 'done' | 'blocked' | 'failed'> = {
    completed: 'done',
    failed: 'failed',
    blocked: 'blocked',
    running: 'running',
    pending: 'pending',
  };
  return {
    stageStates: Object.fromEntries(
      tasks.map((task) => [task.id, { status: map[task.status] ?? 'pending' }]),
    ),
  };
}

function maxFixRounds(): number {
  const parsed = Number(process.env.ROUNDTABLE_MAX_FIX_ROUNDS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

// Derive a fixer task when a task fails (agent error or blocking safety finding).
// The scheduler wires deps + lineage; we only define what the fixer should do.
function makeFixerTask(
  failed: ScheduledTask,
  error: { message: string; scan?: SafetyFinding[] | undefined },
): PlanTask {
  const fixer = AGENT_ROSTER.find((agent) => agent.role === 'fixer') ?? AGENT_ROSTER[0]!;
  const round = (failed.fixRound ?? 0) + 1;
  const findingsText = error.scan && error.scan.length > 0
    ? `\n\nSafety findings:\n${describeFindings(error.scan)}`
    : '';
  return {
    id: `fix_${failed.id}_r${round}`,
    title: `Fix ${failed.title}`,
    assignee: fixer.assignee,
    owner: fixer.id,
    role: fixer.role,
    brief:
      `Repair the failure from "${failed.title}" (${failed.id}). `
      + `Error: ${error.message}.${findingsText}\n\n`
      + `Apply a focused fix and summarize the changed files.`,
    deps: [failed.id],
    parallel: false,
  };
}

function handoffForTurn(actor: Actor | null | undefined, chatId: string, turn: LocalTurn): Handoff {
  return {
    id: id('handoff'),
    ownerId: actor?.id ?? 'local-user',
    chatId,
    createdAt: nowIso(),
    card: {
      id: `handoff-${turn.id}`,
      from: 'orchestrator',
      to: turn.plan.tasks[0]?.assignee ?? '@planning',
      scenario: 'dispatch',
      task: turn.message,
      pinnedMessages: [],
      artifacts: turn.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
      })),
      createdAt: turn.createdAt,
      generatedBy: 'orchestrator',
    },
  };
}

function upsertArtifacts(target: Artifact[], artifacts: Artifact[]): void {
  for (const artifact of artifacts) {
    const index = target.findIndex((item) => item.id === artifact.id && item.chatId === artifact.chatId);
    if (index === -1) target.push(artifact);
    else target[index] = artifact;
  }
}

function compactTitle(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Roundtable task';
}

export class ActionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
