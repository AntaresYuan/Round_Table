import { id, mutateData, nowIso } from '../../store.js';
import type {
  Actor,
  ClarifyAnswer,
  ClarifyQuestion,
  LocalTurn,
  WorkflowTemplate,
  WorkingStyleSnapshot,
} from '../../types.js';
import { applyAnswers, assessClarity } from '../clarify-actions.js';
import { getChat } from '../chat-actions.js';
import {
  buildMissionSnapshot,
  createMission,
  latestMissionForChat,
  resolveWorkflowTemplate,
  selectWorkflowTemplate,
  updateMissionForPlannedTurn,
  workflowRunForTurn,
  workflowTemplateById,
} from '../mission-actions.js';
import { emptyWorkingStyle, getWorkingStyleSnapshot } from '../skill-actions.js';
import { baseArtifacts, upsertArtifacts } from './artifacts.js';
import { ActionError } from './errors.js';
import { handoffForTurn } from './handoffs.js';
import { intakeFromMessage, planFromMessage } from './planning.js';
import { turnResponse, type TurnResponse } from './responses.js';
import { getTurn } from './turn-store.js';

export type CreateTurnInput = {
  message: string;
  turnId?: string | undefined;
  chatId?: string | undefined;
  workflowTemplateId?: string | undefined;
  actor?: Actor | null | undefined;
};

export async function createTurn(input: CreateTurnInput): Promise<TurnResponse> {
  const message = input.message.trim();
  if (!message) throw new ActionError('missing_message', 400);
  const turnId = input.turnId?.trim() || id('turn');
  const chatId = input.chatId?.trim() || null;
  if (chatId && input.actor && !await getChat(input.actor, chatId)) throw new ActionError('chat_not_found', 404);
  const workingStyle = await getWorkingStyleSnapshot(input.actor, chatId);

  // Clarify gate: the planner judges whether the request is clear enough to plan.
  // If not, pause here with multiple-choice questions and DON'T build a plan yet —
  // the user answers, then answerClarification() resumes with the enriched goal.
  // A question is answered as-is: interrogating the user about "scope and tech
  // stack" before answering their question is the build pipeline leaking.
  const intentType = intakeFromMessage(message).intentType;
  const assessment = intentType === 'question'
    ? { clarity: 1, needsClarification: false, questions: [] }
    : await assessClarity(message);
  // Cross-turn continuity: a follow-up request in a chat continues the chat's
  // ongoing mission (revising its plan) instead of stacking a new mission per
  // message. Questions stay standalone — asking about the work must never
  // reset the work's plan.
  const continuedMission = intentType === 'question'
    ? null
    : await latestMissionForChat(input.actor?.id ?? null, chatId);
  // Custom-aware: a user-edited template (same id as a builtin, or a novel
  // one) drives both the mission stages AND the generated task DAG.
  const template = await resolveWorkflowTemplate(input.workflowTemplateId, message);
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
      missionId: continuedMission?.id,
      workflowTemplateId: input.workflowTemplateId,
      template,
      workingStyle,
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
      template,
      workingStyle,
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
    missionId: continuedMission?.id,
    workflowTemplateId: input.workflowTemplateId,
    template,
    workingStyle,
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
    template,
    workingStyle,
    standalone: intentType === 'question',
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
  // The custom-aware resolved template from resolveWorkflowTemplate(). The
  // sync fallback below only sees builtins, so async callers should always
  // resolve and pass this.
  template?: WorkflowTemplate | undefined;
  workingStyle?: WorkingStyleSnapshot | undefined;
}): LocalTurn {
  const { turnId, chatId, ownerId, message, now } = opts;
  const parked = opts.needsClarification === true;
  const workingStyle = opts.workingStyle ?? emptyWorkingStyle();
  const workflowTemplate = opts.template
    ?? (opts.workflowTemplateId
      ? workflowTemplateById(opts.workflowTemplateId)
      : selectWorkflowTemplate(message));
  const missionId = opts.missionId ?? id('mission');
  const intake = intakeFromMessage(message);
  const plan = parked
    ? { summary: `Awaiting clarification: ${message.slice(0, 80)}`, tasks: [] }
    : planFromMessage(message, workingStyle, intake.intentType, workflowTemplate);
  // Question turns produce an answer, not a mission dossier: intake/plan
  // artifacts would be noise next to it.
  const artifacts = parked || intake.intentType === 'question'
    ? []
    : baseArtifacts(turnId, chatId ?? `local-${turnId}`, message, intake, plan, workingStyle);
  const mission = buildMissionSnapshot({
    ownerId,
    chatId,
    turnId,
    missionId,
    goal: message,
    workingStyle,
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
    workingStyle,
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
    workingStyle,
    status: 'done',
    createdAt: now,
    provider: 'roundtable-local',
    model: 'agent-chain-v1',
    pmMessage: parked
      ? 'I need a couple of details before I plan this.'
      : intake.intentType === 'question'
        ? 'This reads as a question — one agent will answer it directly. Start when ready.'
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
  actor: Actor;
}): Promise<TurnResponse> {
  const existing = await getTurn(input.turnId, input);
  if (!existing) throw new ActionError('turn_not_found', 404);
  if (!existing.needsClarification) throw new ActionError('turn_not_awaiting_clarification', 400);

  const enrichedMessage = applyAnswers(existing.message, existing.clarifyQuestions, input.answers);
  const now = nowIso();
  const resumedTemplate = await resolveWorkflowTemplate(existing.workflowTemplateId, enrichedMessage);
  const planned = buildTurn({
    turnId: existing.id,
    chatId: existing.localChatId,
    ownerId: existing.ownerId,
    message: enrichedMessage,
    now,
    clarifyAnswers: input.answers,
    missionId: existing.missionId,
    workflowTemplateId: existing.workflowTemplateId,
    template: resumedTemplate,
    workingStyle: existing.workingStyle,
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
