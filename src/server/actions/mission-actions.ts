import { id, mutateData, nowIso } from '../store.js';
import type {
  Actor,
  Artifact,
  HandoffCardV2,
  LocalTurn,
  Mission,
  MissionCheckpoint,
  MissionFinalDelivery,
  MissionStage,
  MissionStatus,
  MissionTask,
  Plan,
  PlanTask,
  QualityGate,
  QualityGateKind,
  WorkflowRun,
  WorkflowStage,
  WorkflowStageRunStatus,
  WorkflowTemplate,
  AgentRole,
} from '../types.js';
import { agentCardFor, agentForTask } from './agent-roster.js';

const seat = (role: AgentRole, agentId?: string) => ({
  ref: { kind: 'role' as const, role, ...(agentId ? { agentId } : {}) },
});
const userSeat = { ref: { kind: 'user' as const } };

const gate = (
  kind: QualityGateKind,
  label: string,
  description: string,
  actions: string[] = [],
  required = kind !== 'none',
): QualityGate => ({ kind, required, label, description, actions });

export const BUILTIN_WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'wf-feature-builder',
    name: 'Feature Builder',
    tag: 'Flagship',
    desc: 'Turn a vague request into a planned, implemented, reviewed, and reportable feature.',
    builtin: true,
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    planning: { cut: 'by_capability', clarifyThreshold: 0.6, maxClarifyQuestions: 3 },
    stages: [
      {
        id: 'intake',
        name: 'Intake',
        icon: 'clip',
        kind: 'intake',
        desc: 'Capture the user goal, repo context, constraints, and desired output.',
        seats: [userSeat],
        fixed: true,
        gate: gate('none', 'Goal captured', 'The Mission has an initial goal.'),
        requiredInputs: ['goal'],
        expectedOutputs: ['intake artifact'],
        requiredCapabilities: [],
      },
      {
        id: 'clarify',
        name: 'Clarify',
        icon: 'search',
        kind: 'clarify',
        desc: 'Ask only for missing decisions that would change the plan.',
        seats: [seat('planner', 'orchestrator'), seat('pm', 'mira')],
        gate: gate('requirement_clarification', 'Clarification', 'The planner pauses when the request is too vague.', ['answer_questions']),
        requiredInputs: ['goal'],
        expectedOutputs: ['clarified requirements'],
        requiredCapabilities: ['mission.planning', 'product.briefing'],
      },
      {
        id: 'plan',
        name: 'Plan',
        icon: 'layers',
        kind: 'plan',
        desc: 'Produce a technical plan and split the work into agent-owned tasks.',
        seats: [seat('planner', 'orchestrator'), seat('architect', 'nova')],
        gate: gate('plan_approval', 'Plan approval', 'The user approves the plan before agents execute.', ['approve_plan', 'reject_plan']),
        requiredInputs: ['clarified requirements'],
        expectedOutputs: ['plan artifact', 'task graph'],
        requiredCapabilities: ['workflow.decomposition', 'technical.plan'],
      },
      {
        id: 'build',
        name: 'Build',
        icon: 'code',
        kind: 'work',
        desc: 'Implementers produce code and preview artifacts from structured handoffs.',
        seats: [seat('implementer', 'atlas'), seat('implementer', 'beam')],
        parallelGroup: 'build',
        gate: gate('handoff_acceptance', 'Handoff accepted', 'Each implementer receives a compact context package.', ['inspect_handoff'], false),
        requiredInputs: ['approved plan', 'handoff card'],
        expectedOutputs: ['generated artifacts', 'edited artifacts'],
        requiredCapabilities: ['frontend.implementation', 'backend.implementation'],
      },
      {
        id: 'review',
        name: 'Review',
        icon: 'eye',
        kind: 'review',
        desc: 'Reviewer checks requirement coverage, tests, risks, and confidence.',
        seats: [seat('reviewer', 'vera')],
        gate: gate('reviewer_signoff', 'Reviewer confidence', 'Final delivery is blocked until the reviewer reports pass/warn/block.', ['request_repair', 'accept_review']),
        requiredInputs: ['build artifacts'],
        expectedOutputs: ['review artifact', 'risk list', 'confidence recommendation'],
        requiredCapabilities: ['review.quality_gate', 'risk.assessment'],
      },
      {
        id: 'repair',
        name: 'Repair',
        icon: 'wrench',
        kind: 'repair',
        desc: 'Apply focused fixes when safety or review blocks the run.',
        seats: [seat('fixer', 'fixer')],
        gate: gate('test_failure_repair', 'Repair required', 'Failures create follow-up repair work instead of mutating completed tasks.', ['run_repair'], false),
        requiredInputs: ['failed task or blocking review'],
        expectedOutputs: ['repair artifact', 'change summary'],
        requiredCapabilities: ['repair.implementation'],
      },
      {
        id: 'ship',
        name: 'Final Report',
        icon: 'rocket',
        kind: 'ship',
        desc: 'Summarize goal, decisions, artifacts, tests, risks, and recommended next action.',
        seats: [seat('planner', 'orchestrator'), seat('reviewer', 'vera')],
        gate: gate('final_delivery_acceptance', 'Final acceptance', 'The user accepts or rejects the final delivery report.', ['accept_delivery', 'request_repair']),
        requiredInputs: ['review artifact', 'artifact list'],
        expectedOutputs: ['final delivery report'],
        requiredCapabilities: ['confidence_report', 'mission.planning'],
      },
    ],
  },
  {
    id: 'wf-bug-fixer',
    name: 'Bug Fixer',
    tag: 'Diagnosis',
    desc: 'Diagnose a bug, patch it, verify the fix, and summarize residual risk.',
    builtin: true,
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    planning: { cut: 'by_capability', clarifyThreshold: 0.55, maxClarifyQuestions: 3 },
    stages: [
      {
        id: 'intake',
        name: 'Intake',
        icon: 'clip',
        kind: 'intake',
        desc: 'Capture symptoms, expected behavior, logs, and repro hints.',
        seats: [userSeat],
        fixed: true,
        gate: gate('none', 'Bug captured', 'The Mission has a bug report.'),
        requiredInputs: ['bug report'],
        expectedOutputs: ['bug intake'],
        requiredCapabilities: [],
      },
      {
        id: 'plan',
        name: 'Diagnose',
        icon: 'search',
        kind: 'plan',
        desc: 'Map likely causes and pick the smallest safe fix path.',
        seats: [seat('planner', 'orchestrator'), seat('architect', 'nova')],
        gate: gate('plan_approval', 'Fix plan approval', 'The user approves the diagnosis before patching.', ['approve_plan', 'reject_plan']),
        requiredInputs: ['bug intake'],
        expectedOutputs: ['diagnosis plan'],
        requiredCapabilities: ['technical.plan', 'risk_modeling'],
      },
      {
        id: 'build',
        name: 'Patch',
        icon: 'wrench',
        kind: 'work',
        desc: 'Apply the focused patch and preserve surrounding behavior.',
        seats: [seat('implementer', 'beam'), seat('implementer', 'atlas')],
        gate: gate('none', 'Patch ready', 'The patch can proceed after plan approval.'),
        requiredInputs: ['approved diagnosis'],
        expectedOutputs: ['patch artifact'],
        requiredCapabilities: ['backend.implementation', 'frontend.implementation'],
      },
      {
        id: 'review',
        name: 'Verify',
        icon: 'eye',
        kind: 'review',
        desc: 'Reviewer checks the repro path, tests, and regression risk.',
        seats: [seat('reviewer', 'vera')],
        gate: gate('reviewer_signoff', 'Verification sign-off', 'A reviewer must confirm the fix before delivery.', ['request_repair', 'accept_review']),
        requiredInputs: ['patch artifact'],
        expectedOutputs: ['verification report'],
        requiredCapabilities: ['review.quality_gate', 'test_evidence'],
      },
      {
        id: 'ship',
        name: 'Final Report',
        icon: 'rocket',
        kind: 'ship',
        desc: 'Summarize fix, verification, and remaining risk.',
        seats: [seat('planner', 'orchestrator')],
        gate: gate('final_delivery_acceptance', 'Final acceptance', 'The user accepts the bug-fix report.', ['accept_delivery', 'request_repair']),
        requiredInputs: ['verification report'],
        expectedOutputs: ['final delivery report'],
        requiredCapabilities: ['mission.planning'],
      },
    ],
  },
  {
    id: 'wf-codebase-onboarding',
    name: 'Codebase Onboarding',
    tag: 'Discovery',
    desc: 'Understand an unfamiliar repo, map architecture, and propose starter tasks.',
    builtin: true,
    version: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    planning: { cut: 'by_capability', clarifyThreshold: 0.5, maxClarifyQuestions: 2 },
    stages: [
      {
        id: 'intake',
        name: 'Intake',
        icon: 'clip',
        kind: 'intake',
        desc: 'Capture what the user wants to learn or change.',
        seats: [userSeat],
        fixed: true,
        gate: gate('none', 'Scope captured', 'The onboarding scope is recorded.'),
        requiredInputs: ['repo path', 'learning goal'],
        expectedOutputs: ['onboarding intake'],
        requiredCapabilities: [],
      },
      {
        id: 'plan',
        name: 'Map',
        icon: 'layers',
        kind: 'plan',
        desc: 'Create a codebase map with major modules, flows, and ownership hints.',
        seats: [seat('architect', 'nova'), seat('planner', 'orchestrator')],
        gate: gate('none', 'Map ready', 'The architecture map can proceed directly.'),
        requiredInputs: ['repo context'],
        expectedOutputs: ['architecture map'],
        requiredCapabilities: ['system.design', 'dependency.mapping'],
      },
      {
        id: 'review',
        name: 'Check',
        icon: 'eye',
        kind: 'review',
        desc: 'Review the map for unsupported guesses and missing context.',
        seats: [seat('reviewer', 'vera')],
        gate: gate('reviewer_signoff', 'Confidence check', 'The reviewer marks the onboarding map pass/warn/block.', ['accept_review', 'request_more_context']),
        requiredInputs: ['architecture map'],
        expectedOutputs: ['confidence report'],
        requiredCapabilities: ['review.quality_gate'],
      },
      {
        id: 'ship',
        name: 'Starter Tasks',
        icon: 'rocket',
        kind: 'ship',
        desc: 'Deliver starter tasks and recommended next actions.',
        seats: [seat('pm', 'mira'), seat('planner', 'orchestrator')],
        gate: gate('final_delivery_acceptance', 'Accept onboarding', 'The user accepts or refines the onboarding output.', ['accept_delivery', 'request_refinement']),
        requiredInputs: ['confidence report'],
        expectedOutputs: ['starter task list'],
        requiredCapabilities: ['product.briefing', 'mission.planning'],
      },
    ],
  },
];

export type CreateMissionInput = {
  actor?: Actor | null | undefined;
  ownerId?: string | null | undefined;
  chatId?: string | null | undefined;
  turnId: string;
  missionId?: string | undefined;
  goal: string;
  plan: Plan;
  needsClarification: boolean;
  workflowTemplateId?: string | undefined;
};

export function listWorkflowTemplates(): WorkflowTemplate[] {
  return BUILTIN_WORKFLOW_TEMPLATES.map(cloneTemplate);
}

export function workflowTemplateById(idValue: string | null | undefined): WorkflowTemplate {
  return cloneTemplate(
    BUILTIN_WORKFLOW_TEMPLATES.find((template) => template.id === idValue)
      ?? BUILTIN_WORKFLOW_TEMPLATES[0]!,
  );
}

export function selectWorkflowTemplate(message: string): WorkflowTemplate {
  const lower = message.toLowerCase();
  if (/\b(bug|fix|error|crash|broken|regression|修复|报错|故障|bug)\b/i.test(lower)) {
    return workflowTemplateById('wf-bug-fixer');
  }
  if (/\b(onboard|understand|architecture|map|learn|熟悉|理解|架构|代码库|导览)\b/i.test(lower)) {
    return workflowTemplateById('wf-codebase-onboarding');
  }
  return workflowTemplateById('wf-feature-builder');
}

export async function createMission(input: CreateMissionInput): Promise<Mission> {
  const template = input.workflowTemplateId
    ? workflowTemplateById(input.workflowTemplateId)
    : selectWorkflowTemplate(input.goal);
  const now = nowIso();
  const mission: Mission = {
    id: input.missionId ?? id('mission'),
    ownerId: input.actor?.id ?? input.ownerId ?? null,
    chatId: input.chatId ?? null,
    sourceTurnId: input.turnId,
    goal: input.goal,
    status: input.needsClarification ? 'awaiting_clarification' : 'awaiting_approval',
    workflowTemplateId: template.id,
    workflowTemplateName: template.name,
    currentStageId: input.needsClarification ? 'clarify' : 'plan',
    stages: template.stages.map((stage): MissionStage => ({
      id: stage.id,
      name: stage.name,
      status: stage.id === 'intake' ? 'done' : stage.id === (input.needsClarification ? 'clarify' : 'plan') ? 'active' : 'pending',
      taskIds: taskIdsForStage(stage.id, input.plan.tasks),
      artifactIds: [],
      gate: stage.gate,
    })),
    tasks: input.plan.tasks.map((task) => missionTaskFromPlanTask(task, 'pending', [])),
    checkpoints: checkpointsForTemplate(template, input.needsClarification, now),
    decisions: [],
    artifactIds: [],
    finalDelivery: initialFinalDelivery(),
    createdAt: now,
    updatedAt: now,
  };
  await mutateData((data) => {
    data.missions = [mission, ...data.missions.filter((item) => item.id !== mission.id)];
  });
  return mission;
}

export function buildMissionSnapshot(input: CreateMissionInput): Mission {
  const template = input.workflowTemplateId
    ? workflowTemplateById(input.workflowTemplateId)
    : selectWorkflowTemplate(input.goal);
  const now = nowIso();
  return {
    id: input.missionId ?? id('mission'),
    ownerId: input.actor?.id ?? input.ownerId ?? null,
    chatId: input.chatId ?? null,
    sourceTurnId: input.turnId,
    goal: input.goal,
    status: input.needsClarification ? 'awaiting_clarification' : 'awaiting_approval',
    workflowTemplateId: template.id,
    workflowTemplateName: template.name,
    currentStageId: input.needsClarification ? 'clarify' : 'plan',
    stages: template.stages.map((stage): MissionStage => ({
      id: stage.id,
      name: stage.name,
      status: stage.id === 'intake' ? 'done' : stage.id === (input.needsClarification ? 'clarify' : 'plan') ? 'active' : 'pending',
      taskIds: taskIdsForStage(stage.id, input.plan.tasks),
      artifactIds: [],
      gate: stage.gate,
    })),
    tasks: input.plan.tasks.map((task) => missionTaskFromPlanTask(task, 'pending', [])),
    checkpoints: checkpointsForTemplate(template, input.needsClarification, now),
    decisions: [],
    artifactIds: [],
    finalDelivery: initialFinalDelivery(),
    createdAt: now,
    updatedAt: now,
  };
}

export async function getMission(missionId: string): Promise<Mission | null> {
  return mutateData((data) => data.missions.find((mission) => mission.id === missionId) ?? null);
}

export async function getMissionByTurn(turnId: string): Promise<Mission | null> {
  return mutateData((data) => data.missions.find((mission) => mission.sourceTurnId === turnId) ?? null);
}

export async function listMissions(chatId?: string | undefined): Promise<Mission[]> {
  return mutateData((data) =>
    data.missions
      .filter((mission) => !chatId || mission.chatId === chatId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
}

export async function updateMissionForPlannedTurn(turn: LocalTurn): Promise<Mission | null> {
  return updateMission(turn.missionId, (mission) => syncMissionWithTurn(mission, turn, { artifactIds: [] }));
}

export async function updateMissionForDispatch(turn: LocalTurn): Promise<Mission | null> {
  return updateMission(turn.missionId, (mission) => syncMissionWithTurn(mission, turn, {
    artifactIds: turn.artifacts.map((artifact) => artifact.id),
  }));
}

export async function setMissionRejected(turn: LocalTurn): Promise<Mission | null> {
  return updateMission(turn.missionId, (mission) => ({
    ...mission,
    status: 'blocked',
    currentStageId: 'plan',
    checkpoints: mission.checkpoints.map((checkpoint) =>
      checkpoint.kind === 'plan_approval'
        ? { ...checkpoint, status: 'blocked', requiredAction: 'Revise or restart the plan.', resolvedAt: null }
        : checkpoint,
    ),
    updatedAt: nowIso(),
  }));
}

export function workflowRunForTurn(turn: LocalTurn): WorkflowRun {
  const template = workflowTemplateById(turn.workflowTemplateId);
  const mission = turn.mission ?? missionFromTurnSnapshot(turn, template);
  return workflowRunFromMission(mission, template);
}

export function workflowRunFromMission(mission: Mission, template: WorkflowTemplate): WorkflowRun {
  const taskStates: WorkflowRun['taskStates'] = {};
  for (const task of mission.tasks) {
    taskStates[task.id] = { status: taskStatusToStageStatus(task.status), stageId: task.stageId };
  }

  const stageStates: WorkflowRun['stageStates'] = {};
  for (const stage of template.stages) {
    const missionStage = mission.stages.find((item) => item.id === stage.id);
    const taskIds = missionStage?.taskIds ?? [];
    stageStates[stage.id] = {
      status: missionStage?.status ?? 'pending',
      taskIds,
      artifactIds: missionStage?.artifactIds ?? [],
      gate: stage.gate,
      seatRuns: stage.seats.map((seatItem) => {
        const agentId = seatItem.ref.kind === 'user'
          ? 'user'
          : seatItem.ref.agentId ?? seatItem.ref.role;
        const ownedTasks = mission.tasks.filter((task) =>
          taskIds.includes(task.id)
          && (task.owner === agentId || task.assignee.replace(/^@/, '') === agentId || task.assignee.replace(/^@/, '') === (seatItem.ref.kind === 'role' ? seatItem.ref.role : 'user')),
        );
        return {
          agentId,
          status: aggregateTaskStatus(ownedTasks),
          artifactIds: ownedTasks.flatMap((task) => task.artifactIds),
        };
      }),
    };
  }

  for (const task of mission.tasks) {
    stageStates[task.id] = { status: taskStatusToStageStatus(task.status) };
  }

  return {
    activeStageId: mission.currentStageId,
    stageStates,
    taskStates,
  };
}

export function buildHandoffCardV2(input: {
  mission: Mission;
  turn: LocalTurn;
  task: PlanTask;
  artifacts: Artifact[];
  generatedAt?: string | undefined;
}): HandoffCardV2 {
  const agent = agentForTask(input.task);
  const generatedAt = input.generatedAt ?? nowIso();
  return {
    protocolVersion: 'roundtable.handoff.v2',
    cardId: `handoff-v2-${input.mission.id}-${input.task.id}`,
    missionId: input.mission.id,
    sourceTaskId: input.task.deps[0] ?? null,
    referenceTaskIds: [...input.task.deps],
    fromAgent: 'orchestrator',
    toAgent: agent.id,
    task: {
      id: input.task.id,
      title: input.task.title,
      brief: input.task.brief,
      state: 'pending',
    },
    contextPackage: {
      summary: input.turn.plan.summary,
      includedArtifactIds: input.artifacts.map((artifact) => artifact.id),
      omittedHistoryRef: input.turn.localChatId ? `chat://${input.turn.localChatId}` : `turn://${input.turn.id}`,
    },
    artifacts: input.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
    })),
    nextAction: `Run ${input.task.title}`,
    risks: riskHints(input.turn.message),
    provenance: {
      generatedBy: 'orchestrator',
      generatedAt,
      agentCardSnapshot: agentCardFor(agent),
    },
  };
}

function syncMissionWithTurn(
  mission: Mission,
  turn: LocalTurn,
  opts: { artifactIds: string[] },
): Mission {
  const now = nowIso();
  const template = workflowTemplateById(turn.workflowTemplateId);
  const recordByTask = new Map(turn.dispatch.map((record) => [record.taskId, record]));
  const artifactByTask = new Map<string, string[]>();
  for (const artifact of turn.artifacts) {
    const taskId = turn.plan.tasks.find((task) => artifact.id.startsWith(`${task.id}_`))?.id;
    if (!taskId) continue;
    artifactByTask.set(taskId, [...(artifactByTask.get(taskId) ?? []), artifact.id]);
  }

  const tasks = turn.plan.tasks.map((task) => {
    const record = recordByTask.get(task.id);
    return missionTaskFromPlanTask(task, record?.status ?? taskStatusFromTurn(turn, task.id), artifactByTask.get(task.id) ?? []);
  });

  const stages = template.stages.map((stage) => {
    const taskIds = taskIdsForStage(stage.id, turn.plan.tasks);
    const stageTasks = tasks.filter((task) => task.stageId === stage.id);
    const artifactIds = unique(stageTasks.flatMap((task) => task.artifactIds));
    return {
      id: stage.id,
      name: stage.name,
      status: stageStatusFromTasks(stage, stageTasks, turn),
      taskIds,
      artifactIds,
      gate: stage.gate,
    };
  });

  const status = missionStatusFromTurn(turn, stages);
  const currentStageId = currentStageFromStages(stages, status);
  return {
    ...mission,
    goal: turn.message,
    status,
    currentStageId,
    stages,
    tasks,
    checkpoints: updateCheckpoints(mission.checkpoints, turn, status, now),
    decisions: updateDecisions(mission.decisions, turn, now),
    artifactIds: unique([...mission.artifactIds, ...opts.artifactIds]),
    finalDelivery: finalDeliveryForTurn(turn),
    updatedAt: now,
  };
}

async function updateMission(
  missionId: string,
  update: (mission: Mission) => Mission,
): Promise<Mission | null> {
  return mutateData((data) => {
    const index = data.missions.findIndex((mission) => mission.id === missionId);
    if (index === -1) return null;
    const current = data.missions[index];
    if (!current) return null;
    const next = update(current);
    data.missions[index] = next;
    return next;
  });
}

function missionFromTurnSnapshot(turn: LocalTurn, template: WorkflowTemplate): Mission {
  const now = nowIso();
  return {
    id: turn.missionId,
    ownerId: turn.ownerId,
    chatId: turn.localChatId,
    sourceTurnId: turn.id,
    goal: turn.message,
    status: missionStatusFromTurn(turn, []),
    workflowTemplateId: template.id,
    workflowTemplateName: template.name,
    currentStageId: turn.dispatchStatus === 'completed' ? 'ship' : turn.needsClarification ? 'clarify' : 'plan',
    stages: template.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      status: 'pending',
      taskIds: taskIdsForStage(stage.id, turn.plan.tasks),
      artifactIds: [],
      gate: stage.gate,
    })),
    tasks: turn.plan.tasks.map((task) => missionTaskFromPlanTask(task, 'pending', [])),
    checkpoints: checkpointsForTemplate(template, turn.needsClarification, now),
    decisions: [],
    artifactIds: turn.artifacts.map((artifact) => artifact.id),
    finalDelivery: initialFinalDelivery(),
    createdAt: turn.createdAt,
    updatedAt: now,
  };
}

function missionTaskFromPlanTask(
  task: PlanTask,
  status: MissionTask['status'],
  artifactIds: string[],
): MissionTask {
  return {
    id: task.id,
    stageId: task.stageId ?? stageForTask(task),
    title: task.title,
    assignee: task.assignee,
    owner: task.owner ?? null,
    status,
    deps: [...task.deps],
    artifactIds,
  };
}

function stageForTask(task: PlanTask): string {
  if (task.role === 'planner' || task.id === 'task_planning') return 'plan';
  if (task.role === 'reviewer') return 'review';
  if (task.role === 'fixer' || task.producedFor) return 'repair';
  return 'build';
}

function taskIdsForStage(stageId: string, tasks: PlanTask[]): string[] {
  return tasks.filter((task) => (task.stageId ?? stageForTask(task)) === stageId).map((task) => task.id);
}

function checkpointsForTemplate(template: WorkflowTemplate, needsClarification: boolean, now: string): MissionCheckpoint[] {
  return template.stages
    .filter((stage) => stage.gate.kind !== 'none' && stage.gate.required)
    .map((stage) => {
      const planGate = stage.gate.kind === 'plan_approval';
      const clarifyGate = stage.gate.kind === 'requirement_clarification';
      const satisfied = clarifyGate && !needsClarification;
      return {
        id: `checkpoint_${stage.id}`,
        kind: stage.gate.kind,
        label: stage.gate.label,
        status: satisfied ? 'satisfied' : 'pending',
        requiredAction: planGate
          ? 'Approve the plan to start agent execution.'
          : clarifyGate && needsClarification
            ? 'Answer the planner questions.'
            : null,
        stageId: stage.id,
        createdAt: now,
        resolvedAt: satisfied ? now : null,
      };
    });
}

function updateCheckpoints(
  checkpoints: MissionCheckpoint[],
  turn: LocalTurn,
  status: MissionStatus,
  now: string,
): MissionCheckpoint[] {
  return checkpoints.map((checkpoint) => {
    if (checkpoint.kind === 'requirement_clarification') {
      const satisfied = !turn.needsClarification;
      return {
        ...checkpoint,
        status: satisfied ? 'satisfied' : 'pending',
        requiredAction: satisfied ? null : 'Answer the planner questions.',
        resolvedAt: satisfied ? checkpoint.resolvedAt ?? now : null,
      };
    }
    if (checkpoint.kind === 'plan_approval') {
      const satisfied = turn.approvalStatus === 'approved';
      return {
        ...checkpoint,
        status: satisfied ? 'satisfied' : turn.approvalStatus === 'rejected' ? 'blocked' : 'pending',
        requiredAction: satisfied ? null : 'Approve the plan to start agent execution.',
        resolvedAt: satisfied ? checkpoint.resolvedAt ?? now : null,
      };
    }
    if (checkpoint.kind === 'reviewer_signoff') {
      const reviewerDone = turn.dispatch.some((record) => record.status === 'completed'
        && turn.plan.tasks.find((task) => task.id === record.taskId)?.role === 'reviewer');
      return {
        ...checkpoint,
        status: reviewerDone ? 'satisfied' : status === 'failed' ? 'blocked' : 'pending',
        requiredAction: reviewerDone ? null : 'Wait for reviewer confidence output.',
        resolvedAt: reviewerDone ? checkpoint.resolvedAt ?? now : null,
      };
    }
    if (checkpoint.kind === 'final_delivery_acceptance') {
      const ready = turn.dispatchStatus === 'completed';
      return {
        ...checkpoint,
        status: ready ? 'pending' : checkpoint.status,
        requiredAction: ready ? 'Accept final delivery or request repair.' : checkpoint.requiredAction,
      };
    }
    return checkpoint;
  });
}

function updateDecisions(
  decisions: Mission['decisions'],
  turn: LocalTurn,
  now: string,
): Mission['decisions'] {
  const next = [...decisions];
  if (turn.approvalStatus === 'approved' && !next.some((item) => item.id === `decision_plan_${turn.id}`)) {
    next.push({
      id: `decision_plan_${turn.id}`,
      stageId: 'plan',
      actor: 'user',
      summary: 'Plan approved; agent execution may start.',
      createdAt: turn.approvedAt ?? now,
    });
  }
  if (turn.dispatchStatus === 'completed' && !next.some((item) => item.id === `decision_review_${turn.id}`)) {
    next.push({
      id: `decision_review_${turn.id}`,
      stageId: 'review',
      actor: 'reviewer',
      summary: 'Reviewer output completed; final delivery report can be prepared.',
      createdAt: turn.dispatchedAt ?? now,
    });
  }
  return next;
}

function finalDeliveryForTurn(turn: LocalTurn): MissionFinalDelivery {
  if (turn.dispatchStatus !== 'completed') return initialFinalDelivery();
  const reviewArtifact = turn.artifacts.find((artifact) => artifact.ownerAgentId === 'vera' || artifact.ownerAgentId === 'reviewer');
  return {
    status: 'ready',
    reportArtifactId: reviewArtifact?.id ?? turn.artifacts.at(-1)?.id ?? null,
    recommendation: 'accept',
  };
}

function initialFinalDelivery(): MissionFinalDelivery {
  return { status: 'not_ready', reportArtifactId: null, recommendation: 'review' };
}

function missionStatusFromTurn(turn: LocalTurn, stages: MissionStage[]): MissionStatus {
  if (turn.needsClarification) return 'awaiting_clarification';
  if (turn.approvalStatus === 'rejected') return 'blocked';
  if (turn.needsApproval || turn.approvalStatus === 'pending') return 'awaiting_approval';
  if (turn.dispatchStatus === 'running') return 'running';
  if (turn.dispatchStatus === 'completed') return 'completed';
  if (turn.dispatchStatus === 'failed') return 'failed';
  if (stages.some((stage) => stage.status === 'blocked')) return 'blocked';
  return 'awaiting_approval';
}

function currentStageFromStages(stages: MissionStage[], status: MissionStatus): string | null {
  if (status === 'completed') return 'ship';
  return stages.find((stage) => stage.status === 'active' || stage.status === 'running' || stage.status === 'blocked')?.id
    ?? stages.find((stage) => stage.status === 'pending')?.id
    ?? null;
}

function taskStatusFromTurn(turn: LocalTurn, taskId: string): MissionTask['status'] {
  const live = turn.workflowRun?.taskStates?.[taskId]?.status ?? turn.workflowRun?.stageStates?.[taskId]?.status;
  if (live === 'done') return 'completed';
  if (live === 'running' || live === 'active') return 'running';
  if (live === 'failed') return 'failed';
  if (live === 'blocked') return 'blocked';
  return 'pending';
}

function stageStatusFromTasks(
  stage: WorkflowStage,
  tasks: MissionTask[],
  turn: LocalTurn,
): WorkflowStageRunStatus {
  if (stage.id === 'intake') return 'done';
  if (stage.id === 'clarify') return turn.needsClarification ? 'active' : 'done';
  if (stage.id === 'ship') {
    if (turn.dispatchStatus === 'completed') return 'active';
    if (turn.dispatchStatus === 'failed') return 'blocked';
    return 'pending';
  }
  if (tasks.length === 0) return stage.id === 'plan' && turn.approvalStatus === 'pending' ? 'active' : 'pending';
  return aggregateTaskStatus(tasks);
}

function aggregateTaskStatus(tasks: MissionTask[]): WorkflowStageRunStatus {
  if (tasks.length === 0) return 'pending';
  if (tasks.some((task) => task.status === 'running')) return 'active';
  if (tasks.some((task) => task.status === 'failed')) return 'failed';
  if (tasks.some((task) => task.status === 'blocked')) return 'blocked';
  if (tasks.every((task) => task.status === 'completed')) return 'done';
  return 'pending';
}

function taskStatusToStageStatus(status: MissionTask['status']): WorkflowStageRunStatus {
  if (status === 'completed') return 'done';
  if (status === 'running') return 'running';
  return status;
}

function riskHints(message: string): string[] {
  const risks = [];
  if (/\b(auth|login|payment|billing|权限|支付|登录|鉴权)\b/i.test(message)) {
    risks.push('High-risk domain; reviewer should verify security and failure paths.');
  }
  risks.push('Downstream agents receive compact handoff context, not full raw history.');
  return risks;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function cloneTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return JSON.parse(JSON.stringify(template)) as WorkflowTemplate;
}
