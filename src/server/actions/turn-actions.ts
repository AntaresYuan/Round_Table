import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { id, mutateData, nowIso, readData } from '../store.js';
import type {
  Actor,
  AgentEvent,
  Artifact,
  ClarifyAnswer,
  ClarifyQuestion,
  DispatchRecord,
  Handoff,
  Intake,
  LocalTurn,
  Plan,
  PlanTask,
  WorkflowRun,
} from '../types.js';
import { applyAnswers, assessClarity } from './clarify-actions.js';
import {
  buildHandoffCardV2,
  buildMissionSnapshot,
  createMission,
  selectWorkflowTemplate,
  setMissionRejected,
  updateMissionForDispatch,
  updateMissionForPlannedTurn,
  workflowRunForTurn,
  workflowTemplateById,
} from './mission-actions.js';
import { runAgentTask, normalizeAdapter } from './agent-runner.js';
import { E2BUnavailableError } from './adapters/e2b-adapter.js';
import { MiniMaxUnavailableError } from './adapters/minimax-adapter.js';
import { OpenAICompatUnavailableError } from './adapters/openai-compat-adapter.js';
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
  workflowTemplateId?: string | undefined;
  actor?: Actor | null | undefined;
};

export type ApprovalInput = {
  turnId: string;
  decision: 'approve' | 'reject';
  autoDispatch?: boolean | undefined;
  agentAdapter?: string | undefined;
  // When true, kick off dispatch in the background and return immediately with
  // dispatchStatus 'running' — the client then polls /history for live progress.
  // When false/omitted, await the full run (used by tests and the CLI).
  background?: boolean | undefined;
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

  // Clarify gate: the planner judges whether the request is clear enough to plan.
  // If not, pause here with multiple-choice questions and DON'T build a plan yet —
  // the user answers, then answerClarification() resumes with the enriched goal.
  const assessment = await assessClarity(message);
  const now = nowIso();
  if (assessment.needsClarification) {
    const turn = buildTurn({
      turnId,
      chatId,
      ownerId: input.actor?.id ?? null,
      message,
      now,
      needsClarification: true,
      clarifyQuestions: assessment.questions,
      clarifyAnswers: [],
      workflowTemplateId: input.workflowTemplateId,
    });
    const mission = await createMission({
      actor: input.actor,
      chatId,
      turnId: turn.id,
      missionId: turn.missionId,
      goal: message,
      plan: turn.plan,
      needsClarification: true,
      workflowTemplateId: turn.workflowTemplateId,
    });
    const turnWithMission = {
      ...turn,
      mission,
      workflowRun: workflowRunForTurn({ ...turn, mission }),
    };
    await mutateData((data) => {
      data.turns = [turnWithMission, ...data.turns.filter((item) => item.id !== turnId)];
    });
    return turnResponse(turnWithMission);
  }

  const turn = buildTurn({
    turnId,
    chatId,
    ownerId: input.actor?.id ?? null,
    message,
    now,
    workflowTemplateId: input.workflowTemplateId,
  });
  const mission = await createMission({
    actor: input.actor,
    chatId,
    turnId: turn.id,
    missionId: turn.missionId,
    goal: message,
    plan: turn.plan,
    needsClarification: false,
    workflowTemplateId: turn.workflowTemplateId,
  });
  const turnWithMission = {
    ...turn,
    mission,
    workflowRun: workflowRunForTurn({ ...turn, mission }),
  };
  await mutateData((data) => {
    data.turns = [turnWithMission, ...data.turns.filter((item) => item.id !== turnId)];
    if (chatId) {
      upsertArtifacts(data.artifacts, turnWithMission.artifacts);
      data.handoffs.push(handoffForTurn(input.actor, chatId, turnWithMission));
    }
  });
  return turnResponse(turnWithMission);
}

// Builds a LocalTurn. When `needsClarification` is set the turn is parked before
// planning (empty plan); otherwise a real plan + base artifacts are attached.
function buildTurn(opts: {
  turnId: string;
  chatId: string | null;
  ownerId: string | null;
  message: string;
  now: string;
  needsClarification?: boolean;
  clarifyQuestions?: ClarifyQuestion[];
  clarifyAnswers?: ClarifyAnswer[];
  missionId?: string | undefined;
  workflowTemplateId?: string | undefined;
}): LocalTurn {
  const { turnId, chatId, ownerId, message, now } = opts;
  const parked = opts.needsClarification === true;
  const workflowTemplate = opts.workflowTemplateId
    ? workflowTemplateById(opts.workflowTemplateId)
    : selectWorkflowTemplate(message);
  const missionId = opts.missionId ?? id('mission');
  const intake = intakeFromMessage(message);
  const plan = parked ? { summary: `Awaiting clarification: ${message.slice(0, 80)}`, tasks: [] } : planFromMessage(message);
  const artifacts = parked ? [] : baseArtifacts(turnId, chatId ?? `local-${turnId}`, message, intake, plan);
  const mission = buildMissionSnapshot({
    ownerId,
    chatId,
    turnId,
    missionId,
    goal: message,
    plan,
    needsClarification: parked,
    workflowTemplateId: workflowTemplate.id,
  });
  const workflowRun = workflowRunForTurn({
    id: turnId,
    localChatId: chatId,
    ownerId,
    missionId,
    workflowTemplateId: workflowTemplate.id,
    message,
    status: 'done',
    createdAt: now,
    provider: 'roundtable-local',
    model: 'agent-chain-v1',
    pmMessage: '',
    needsClarification: parked,
    clarifyQuestions: opts.clarifyQuestions ?? [],
    clarifyAnswers: opts.clarifyAnswers ?? [],
    needsApproval: !parked,
    approvalStatus: parked ? 'approved' : 'pending',
    approvedAt: parked ? now : null,
    dispatchStatus: 'not_started',
    dispatchAdapter: null,
    dispatchedAt: null,
    dispatchStage: parked ? 'clarifying' : 'awaiting_approval',
    dispatchError: null,
    dispatchWorkspacePath: null,
    dispatch: [],
    artifacts,
    intake,
    plan,
    workflow: workflowTemplate,
    workflowRun: null,
    mission,
    error: null,
  });
  return {
    id: turnId,
    localChatId: chatId,
    ownerId,
    missionId,
    workflowTemplateId: workflowTemplate.id,
    message,
    status: 'done',
    createdAt: now,
    provider: 'roundtable-local',
    model: 'agent-chain-v1',
    pmMessage: parked
      ? 'I need a couple of details before I plan this.'
      : `Plan ready — ${plan.tasks.length} agent step${plan.tasks.length === 1 ? '' : 's'}. Review and start when you're ready.`,
    needsClarification: parked,
    clarifyQuestions: opts.clarifyQuestions ?? [],
    clarifyAnswers: opts.clarifyAnswers ?? [],
    // The plan must be reviewed and approved by the user before any agent runs.
    // A parked (clarifying) turn has no plan yet, so it isn't pending approval.
    needsApproval: !parked,
    approvalStatus: parked ? 'approved' : 'pending',
    approvedAt: parked ? now : null,
    dispatchStatus: 'not_started',
    dispatchAdapter: null,
    dispatchedAt: null,
    dispatchStage: parked ? 'clarifying' : 'awaiting_approval',
    dispatchError: null,
    dispatchWorkspacePath: null,
    dispatch: [],
    artifacts,
    intake,
    plan,
    workflow: workflowTemplate,
    workflowRun,
    mission,
    error: null,
  };
}

/**
 * Resume a clarification-parked turn: fold the user's choices into the goal,
 * build the real plan, and replace the parked turn so it can be dispatched.
 */
export async function answerClarification(input: {
  turnId: string;
  answers: ClarifyAnswer[];
  actor?: Actor | null | undefined;
}): Promise<TurnResponse> {
  const existing = await getTurn(input.turnId);
  if (!existing) throw new ActionError('turn_not_found', 404);
  if (!existing.needsClarification) throw new ActionError('turn_not_awaiting_clarification', 400);

  const enrichedMessage = applyAnswers(existing.message, existing.clarifyQuestions, input.answers);
  const now = nowIso();
  const planned = buildTurn({
    turnId: existing.id,
    chatId: existing.localChatId,
    ownerId: existing.ownerId,
    message: enrichedMessage,
    now,
    clarifyAnswers: input.answers,
    missionId: existing.missionId,
    workflowTemplateId: existing.workflowTemplateId,
  });
  // Preserve the original user-facing message; keep the enriched text in the plan.
  const syncedMission = await updateMissionForPlannedTurn({
    ...planned,
    message: existing.message,
    createdAt: existing.createdAt,
  });
  const turn: LocalTurn = {
    ...planned,
    message: existing.message,
    createdAt: existing.createdAt,
    mission: syncedMission ?? planned.mission,
  };
  const turnWithWorkflowRun: LocalTurn = {
    ...turn,
    workflowRun: workflowRunForTurn(turn),
  };

  await mutateData((data) => {
    data.turns = [turnWithWorkflowRun, ...data.turns.filter((item) => item.id !== turn.id)];
    if (turnWithWorkflowRun.localChatId) {
      upsertArtifacts(data.artifacts, turnWithWorkflowRun.artifacts);
      data.handoffs.push(handoffForTurn(input.actor, turnWithWorkflowRun.localChatId, turnWithWorkflowRun));
    }
  });
  return turnResponse(turnWithWorkflowRun);
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
    const rejectedTurn = requireTurn(rejected);
    const mission = await setMissionRejected(rejectedTurn);
    const withMission = await updateTurn(rejectedTurn.id, (current) => ({
      ...current,
      mission: mission ?? current.mission,
      workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
    }));
    return dispatchResponse(requireTurn(withMission));
  }

  const approved = await updateTurn(input.turnId, (current) => ({
    ...current,
    needsApproval: false,
    approvalStatus: 'approved',
    approvedAt: nowIso(),
    dispatchStage: 'approved',
  }));
  const approvedTurn = requireTurn(approved);
  const mission = await updateMissionForPlannedTurn(approvedTurn);
  const synced = await updateTurn(approvedTurn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  }));
  const next = requireTurn(synced);
  if (input.autoDispatch) {
    if (input.background) {
      // Mark running now, run the DAG in the background, and return immediately.
      // The client polls /history; per-task stageStates stream in as agents work.
      const running = await updateTurn(next.id, (current) => {
        const runTurn = {
          ...current,
          dispatchStatus: 'running' as const,
          dispatchStage: 'dispatch',
          dispatchError: null,
        };
        return {
          ...runTurn,
          workflowRun: workflowRunForTurn(runTurn),
        };
      });
      const runningTurn = requireTurn(running);
      const runningMission = await updateMissionForDispatch(runningTurn);
      const runningSynced = await updateTurn(next.id, (current) => ({
        ...current,
        mission: runningMission ?? current.mission,
        workflowRun: workflowRunForTurn({ ...current, mission: runningMission ?? current.mission }),
      }));
      void dispatchTurn({ turnId: next.id, agentAdapter: input.agentAdapter }).catch(async (error) => {
        const message = error instanceof Error ? error.message : 'dispatch_failed';
        await updateTurn(next.id, (current) => ({
          ...current,
          dispatchStatus: 'failed',
          dispatchStage: 'failed',
          dispatchError: message,
        })).catch(() => {});
      });
      return dispatchResponse(requireTurn(runningSynced));
    }
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
    let fallbackNote: AgentEvent | null = null;
    try {
      result = await runAgentTask({ adapter, workspace, task, message: turn.message, handoffContext });
    } catch (error) {
      // Opt-in adapter unavailable (E2B / MiniMax / OpenAI-compatible): fall back
      // to local-dispatch in this layer (not silently inside the adapter). The
      // fallback is surfaced as an event on the task so a misconfig is visible
      // in the UI, not hidden.
      if (
        error instanceof E2BUnavailableError
        || error instanceof MiniMaxUnavailableError
        || error instanceof OpenAICompatUnavailableError
      ) {
        fallbackNote = {
          type: 'thinking_delta',
          delta: `${error.name} (${error.message}); fell back to local-dispatch.`,
        };
        result = await runAgentTask({ adapter: 'local-dispatch', workspace, task, message: turn.message, handoffContext });
      } else {
        throw error;
      }
    }

    eventsByTask.set(task.id, fallbackNote ? [fallbackNote, ...result.events] : result.events);
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

    // The plan is now defined: once the planner finishes, the downstream tasks
    // are no longer "awaiting plan" — give them concrete titles so the UI stops
    // showing three placeholder rows that all looked the same.
    if (task.role === 'planner') {
      await retitleDownstreamTasks(turn.id, task.id, turn.message);
    }

    // Review gate: a reviewer that reports blocking (Critical/High) issues should
    // trigger a fix, not silently end the run. Treat such a review as a failure
    // so the scheduler derives a fixer via onFailure (bounded by maxFixRounds);
    // the fixer receives this review as its repair context. A clean review passes.
    if (task.role === 'reviewer' && reviewRequestsFix()) {
      const severities = reviewSeverities(result.text);
      if (severities.blocking > 0) {
        return {
          ok: false,
          error: { message: `review_found_issues: ${severities.label}`, review: result.text },
        };
      }
    }

    return { ok: true, output: { summary: result.text, artifactId: artifactByTask.get(task.id)?.id } };
  };

  // Fixer tasks the scheduler derives at runtime, keyed by id, so onTaskState can
  // fold them into the persisted plan as they start (the UI reads plan.tasks).
  const derivedById = new Map<string, PlanTask>();

  // Stream per-task progress into the turn's workflowRun.stageStates as each
  // agent starts/finishes, so the polling UI can animate the roundtable (who's
  // working right now) instead of jumping straight from "queued" to "done".
  // onTaskState is awaited sequentially by the scheduler, so its store write does
  // not race the final updateTurn (which only runs after the scheduler returns).
  const schedulerToStage = { running: 'running', completed: 'done', failed: 'failed', blocked: 'blocked' } as const;
  const onTaskState = async (taskId: string, status: 'running' | 'completed' | 'failed' | 'blocked') => {
    const derived = derivedById.get(taskId);
    await updateTurn(turn.id, (current) => {
      const planHasTask = current.plan.tasks.some((task) => task.id === taskId);
      const tasks = derived && !planHasTask
        ? [...current.plan.tasks, derived]
        : current.plan.tasks;
      return {
        ...current,
        plan: { ...current.plan, tasks },
        dispatchStage: status === 'running' ? `running:${taskId}` : current.dispatchStage,
        workflowRun: {
          ...(current.workflowRun ?? { activeStageId: null, stageStates: {}, taskStates: {} }),
          stageStates: {
            ...(current.workflowRun?.stageStates ?? {}),
            [taskId]: { status: schedulerToStage[status] },
          },
          taskStates: {
            ...(current.workflowRun?.taskStates ?? {}),
            [taskId]: {
              status: schedulerToStage[status],
              stageId: tasks.find((task) => task.id === taskId)?.stageId ?? null,
            },
          },
        },
      };
    });
    const current = await getTurn(turn.id);
    if (current) {
      const mission = await updateMissionForDispatch(current);
      await updateTurn(turn.id, (latest) => ({
        ...latest,
        mission: mission ?? latest.mission,
        workflowRun: workflowRunForTurn({ ...latest, mission: mission ?? latest.mission }),
      }));
    }
  };

  const run = await runScheduler({
    tasks: turn.plan.tasks,
    runTask,
    maxFixRounds: maxFixRounds(),
    now: nowIso,
    onFailure: (failed, error) => {
      const fixer = makeFixerTask(failed, error);
      // Remember it so onTaskState can add it to the persisted plan when it runs
      // (a concurrent write here would race the store's read-modify-write).
      derivedById.set(fixer.id, fixer);
      return fixer;
    },
    onTaskState,
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

  // A failed task is "repaired" if a fixer in its lineage completed. Walk the
  // producedFor chain from every completed fixer back to the originally failed
  // task so a successful fix doesn't leave the whole run marked failed.
  const taskById = new Map(run.tasks.map((task) => [task.id, task]));
  const repaired = new Set<string>();
  for (const task of run.tasks) {
    if (task.status !== 'completed' || task.producedFor === undefined) continue;
    let cursor: string | undefined = task.producedFor;
    while (cursor) {
      repaired.add(cursor);
      cursor = taskById.get(cursor)?.producedFor;
    }
  }
  // The run failed only if a task ended failed/blocked AND was not repaired.
  const failed = run.tasks.some(
    (task) => (task.status === 'failed' || task.status === 'blocked') && !repaired.has(task.id),
  );
  // Persist any fixer tasks the scheduler derived at runtime back into the plan,
  // so the UI (roundtable + todo list, which read plan.tasks) shows the fix pass
  // — front and back stay in sync on the real executed graph.
  const plannedIds = new Set(turn.plan.tasks.map((task) => task.id));
  const derivedTasks: PlanTask[] = run.tasks
    .filter((task) => !plannedIds.has(task.id))
    .map((task) => ({
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      owner: task.owner,
      role: task.role,
      stageId: task.stageId,
      requiredCapabilities: task.requiredCapabilities,
      brief: task.brief,
      deps: task.deps,
      parallel: task.parallel,
      ...(task.producedFor !== undefined ? { producedFor: task.producedFor } : {}),
      ...(task.fixRound !== undefined ? { fixRound: task.fixRound } : {}),
    }));
  const completed = await updateTurn(turn.id, (current) => {
    const nextTurn = {
      ...current,
      plan: derivedTasks.length > 0
        ? { ...current.plan, tasks: [...current.plan.tasks, ...derivedTasks] }
        : current.plan,
      dispatchStatus: failed ? 'failed' as const : 'completed' as const,
      dispatchAdapter: adapter,
      dispatchedAt: nowIso(),
      dispatchStage: failed ? 'failed' : 'done',
      dispatchError: failed ? 'one_or_more_tasks_failed' : null,
      dispatchWorkspacePath: workspace,
      dispatch: records,
      artifacts,
    };
    const legacyRun = workflowRunFromTasks(run.tasks);
    const missionRun = workflowRunForTurn(nextTurn);
    return {
      ...nextTurn,
      workflowRun: {
        ...missionRun,
        stageStates: {
          ...missionRun.stageStates,
          ...legacyRun.stageStates,
        },
        taskStates: {
          ...missionRun.taskStates,
          ...legacyRun.taskStates,
        },
      },
    };
  });
  const completedTurn = requireTurn(completed);
  const mission = await updateMissionForDispatch(completedTurn);
  const finalTurn = requireTurn(await updateTurn(completedTurn.id, (current) => ({
    ...current,
    mission: mission ?? current.mission,
    workflowRun: workflowRunForTurn({ ...current, mission: mission ?? current.mission }),
  })));
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
    missionId: turn.missionId,
    workflowTemplateId: turn.workflowTemplateId,
    provider: turn.provider,
    model: turn.model,
    pmMessage: turn.pmMessage,
    needsClarification: turn.needsClarification,
    clarifyQuestions: turn.clarifyQuestions,
    clarifyAnswers: turn.clarifyAnswers,
    needsApproval: turn.needsApproval,
    approvalStatus: turn.approvalStatus,
    dispatchStatus: turn.dispatchStatus,
    dispatchStage: turn.dispatchStage,
    artifacts: turn.artifacts,
    intake: turn.intake,
    plan: turn.plan,
    workflow: turn.workflow,
    workflowRun: turn.workflowRun,
    mission: turn.mission,
  };
}

function dispatchResponse(turn: LocalTurn) {
  return {
    ok: true,
    id: turn.id,
    missionId: turn.missionId,
    workflowTemplateId: turn.workflowTemplateId,
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
    mission: turn.mission,
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
        taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false, 'plan'),
        taskForAgent(`task_${implementer.id}`, titleForAgent(implementer, base), implementer, goal, ['task_planning'], false, 'build'),
        taskForAgent(`task_${reviewerAgent.id}`, titleForAgent(reviewerAgent, base), reviewerAgent, goal, [`task_${implementer.id}`], false, 'review'),
      ],
    };
  }

  if (startsWithPlanning || explicitPlanningOnly) {
    tasks.push(taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false, 'plan'));
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
        stageIdForAgent(agent),
      ));
      previousTaskId = idValue;
    }
  }

  return {
    summary: `Plan for: ${base}`,
    tasks: tasks.length > 0 ? tasks : [taskForAgent('task_planning', `Plan ${base}`, planner(), goal, [], false, 'plan')],
  };
}

function taskForAgent(
  idValue: string,
  title: string,
  agent: AgentProfile,
  message: string,
  deps: string[],
  parallel: boolean,
  stageId: string,
): PlanTask {
  return {
    id: idValue,
    title,
    assignee: agent.assignee,
    owner: agent.id,
    role: agent.role,
    stageId,
    requiredCapabilities: agent.capabilities,
    brief: `${title}. Agent: ${agent.displayName}. Role: ${agent.role}. User request: ${message}`,
    deps,
    parallel,
  };
}

function stageIdForAgent(agent: AgentProfile): string {
  if (agent.role === 'planner' || agent.role === 'architect' || agent.role === 'pm') return 'plan';
  if (agent.role === 'reviewer') return 'review';
  if (agent.role === 'fixer') return 'repair';
  return 'build';
}

// Concrete title for a downstream task AFTER the planner has run. At this point
// the plan defines the work, so naming the goal is accurate (not a guess). Used
// by retitleDownstreamTasks() to replace the "awaiting plan" placeholders.
function plannedTitleForRole(role: string | undefined, displayName: string, goal: string): string {
  if (role === 'pm') return `Product brief for ${goal}`;
  if (role === 'architect') return `Architecture for ${goal}`;
  if (role === 'implementer') return `Build ${goal} (${displayName})`;
  if (role === 'reviewer') return `Review ${goal}`;
  if (role === 'fixer') return `Fix issues for ${goal}`;
  return `Plan ${goal}`;
}

// Once the planner task completes, rewrite every task that (transitively)
// depends on it from its placeholder title to a concrete one. The plan now
// exists, so the downstream tasks have a real, named scope.
async function retitleDownstreamTasks(turnId: string, plannerTaskId: string, message: string): Promise<void> {
  const goal = compactTitle(messageWithoutMentions(message) || message);
  await updateTurn(turnId, (current) => {
    const tasks = current.plan.tasks;
    // Build the set of tasks reachable from the planner via deps.
    const downstream = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (downstream.has(task.id)) continue;
        if (task.deps.includes(plannerTaskId) || task.deps.some((dep) => downstream.has(dep))) {
          downstream.add(task.id);
          changed = true;
        }
      }
    }
    if (downstream.size === 0) return current;
    const ownerName = (task: PlanTask): string =>
      AGENT_ROSTER.find((agent) => agent.id === task.owner)?.displayName ?? task.owner ?? task.role ?? 'agent';
    return {
      ...current,
      plan: {
        ...current.plan,
        tasks: tasks.map((task) =>
          downstream.has(task.id)
            ? { ...task, title: plannedTitleForRole(task.role, ownerName(task), goal) }
            : task,
        ),
      },
    };
  });
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

// Title for a task at PLAN TIME — before the planner has run. Only the planner
// itself knows the concrete goal up front; every downstream task is still
// undefined (its real scope is decided once the plan lands), so we show a
// responsibility placeholder, NOT the user's raw request. dispatchTurn() later
// rewrites these from the planner's actual output via retitleDownstreamTasks().
function titleForAgent(agent: AgentProfile, base: string): string {
  if (agent.role === 'planner') return `Plan ${base}`;
  if (agent.role === 'pm') return 'Product brief · awaiting plan';
  if (agent.role === 'architect') return 'Architecture · awaiting plan';
  if (agent.role === 'implementer') return `Build · awaiting plan (${agent.displayName})`;
  if (agent.role === 'reviewer') return 'Review · awaits the build';
  if (agent.role === 'fixer') return 'Fix issues · awaits review';
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
    await clearRunOutput(projectWorkspace);
    return projectWorkspace;
  }
  const root = resolve(process.env.ROUNDTABLE_WORKSPACE_ROOT || '.roundtable/workspaces');
  const workspace = resolve(root, turn.localChatId ?? turn.id);
  await mkdir(workspace, { recursive: true });
  await clearRunOutput(workspace);
  return workspace;
}

// Wipe this system's own output tree (.roundtable/runs) before a run so a
// re-dispatch — or a different request in the same chat — doesn't leave stale
// artifacts from the previous run mixed in with the new ones. Only the runs/
// subtree is removed; any real project files in the workspace are untouched.
async function clearRunOutput(workspace: string): Promise<void> {
  try {
    await rm(join(workspace, '.roundtable', 'runs'), { recursive: true, force: true });
  } catch {
    // Best-effort: a missing dir or transient FS error must not block the run.
  }
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
    activeStageId: null,
    stageStates: Object.fromEntries(
      tasks.map((task) => [task.id, { status: map[task.status] ?? 'pending' }]),
    ),
    taskStates: Object.fromEntries(
      tasks.map((task) => [task.id, {
        status: map[task.status] ?? 'pending',
        stageId: task.stageId ?? null,
      }]),
    ),
  };
}

function maxFixRounds(): number {
  const parsed = Number(process.env.ROUNDTABLE_MAX_FIX_ROUNDS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
}

// Whether a reviewer that reports blocking issues should trigger a fix pass.
// On by default; set ROUNDTABLE_REVIEW_TRIGGERS_FIX=false to disable.
function reviewRequestsFix(): boolean {
  return process.env.ROUNDTABLE_REVIEW_TRIGGERS_FIX !== 'false';
}

// Parse a reviewer's Markdown report for severity signals. Counts Critical/High
// (blocking) mentions across EN + 中文 wording. Heuristic by design: reviewers
// write prose, and a count > 0 is enough to decide "this needs a fix pass".
export function reviewSeverities(report: string): { blocking: number; label: string } {
  const critical = countMatches(report, /\b(critical|blocker|severe)\b|🔴|严重|致命|阻断/gi);
  const high = countMatches(report, /\bhigh\b|🟠|高危|高优先级/gi);
  // "If it is solid, say so" — an explicit all-clear shouldn't trigger a fix.
  const allClear = /\b(no (issues|blockers)|looks good|lgtm|ship it|solid)\b|没有(发现)?问题|可以(直接)?交付|无明显问题/i.test(report);
  const blocking = allClear ? 0 : critical + high;
  const label = `${critical} critical · ${high} high`;
  return { blocking, label };
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) || []).length;
}

// Derive a fixer task when a task fails (agent error or blocking safety finding).
// The scheduler wires deps + lineage; we only define what the fixer should do.
function makeFixerTask(
  failed: ScheduledTask,
  error: { message: string; scan?: SafetyFinding[] | undefined; review?: string | undefined },
): PlanTask {
  const fixer = AGENT_ROSTER.find((agent) => agent.role === 'fixer') ?? AGENT_ROSTER[0]!;
  const round = (failed.fixRound ?? 0) + 1;
  const fromReview = failed.role === 'reviewer';
  const findingsText = error.scan && error.scan.length > 0
    ? `\n\nSafety findings:\n${describeFindings(error.scan)}`
    : '';
  const reviewText = error.review ? `\n\nReview report to address:\n\n${error.review}` : '';
  return {
    id: `fix_${failed.id}_r${round}`,
    // A review-driven fix reads better as "Apply review fixes" than "Fix Review …".
    title: fromReview ? `Apply review fixes (round ${round})` : `Fix ${failed.title}`,
    assignee: fixer.assignee,
    owner: fixer.id,
    role: fixer.role,
    stageId: 'repair',
    requiredCapabilities: fixer.capabilities,
    brief: fromReview
      ? `The reviewer found blocking issues (${error.message}). Apply focused fixes to the `
        + `implementer's deliverable so each Critical/High issue is resolved, and output the `
        + `corrected deliverable plus a short summary of what changed.${reviewText}`
      : `Repair the failure from "${failed.title}" (${failed.id}). `
        + `Error: ${error.message}.${findingsText}${reviewText}\n\n`
        + `Apply a focused fix and summarize the changed files.`,
    deps: [failed.id],
    parallel: false,
  };
}

function handoffForTurn(actor: Actor | null | undefined, chatId: string, turn: LocalTurn): Handoff {
  const mission = turn.mission ?? buildMissionSnapshot({
    ownerId: turn.ownerId,
    chatId: turn.localChatId,
    turnId: turn.id,
    missionId: turn.missionId,
    goal: turn.message,
    plan: turn.plan,
    needsClarification: turn.needsClarification,
    workflowTemplateId: turn.workflowTemplateId,
  });
  const firstTask = turn.plan.tasks[0];
  const v2 = firstTask
    ? buildHandoffCardV2({ mission, turn, task: firstTask, artifacts: turn.artifacts, generatedAt: turn.createdAt })
    : null;
  return {
    id: id('handoff'),
    ownerId: actor?.id ?? 'local-user',
    chatId,
    createdAt: nowIso(),
    card: {
      protocolVersion: v2?.protocolVersion ?? 'roundtable.handoff.v1',
      missionId: turn.missionId,
      handoffV2: v2,
      id: `handoff-${turn.id}`,
      from: 'orchestrator',
      to: turn.plan.tasks[0]?.assignee ?? '@planning',
      scenario: 'dispatch',
      task: turn.message,
      userIntent: turn.message,
      taskBrief: firstTask?.brief ?? turn.plan.summary,
      pinnedMessages: [],
      rolesInGroup: AGENT_ROSTER,
      previousAgent: null,
      relevantArtifacts: turn.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
      })),
      fullHistoryRef: turn.localChatId ? `chat://${turn.localChatId}` : `turn://${turn.id}`,
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
  // Titles should read as the core ask, not the whole enriched goal. Drop the
  // clarification block appended by applyAnswers() ("...\n\nClarified
  // requirements:\n- ...") so Plan/Build/Review titles don't all repeat the same
  // long string. The full enriched text still lives in each task's brief.
  const core = stripClarification(message);
  return core.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Roundtable task';
}

// Mirror of applyAnswers()'s appended block ("\n\nClarified requirements:\n…").
// Whitespace-tolerant: by the time a title is built the goal may have had its
// newlines collapsed to single spaces, so match either form. Keep the marker
// text in sync with clarify-actions.ts applyAnswers().
const CLARIFICATION_MARKER = /\s*Clarified requirements:[\s\S]*$/;

function stripClarification(message: string): string {
  return message.replace(CLARIFICATION_MARKER, '');
}

export class ActionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
