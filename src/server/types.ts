export type Actor = {
  id: string;
  email: string;
  name: string | null;
};

export type ArtifactKind = 'markdown' | 'code' | 'preview' | 'file' | 'diff' | 'html' | 'spec';

export type Workbench = {
  id: string;
  ownerId: string;
  name: string;
  workspacePath: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Chat = {
  id: string;
  ownerId: string;
  workbenchId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  ownerId: string;
  chatId: string;
  authorType: 'user' | 'agent' | 'system';
  authorId: string;
  content: string;
  createdAt: string;
};

export type Artifact = {
  id: string;
  chatId: string;
  kind: ArtifactKind;
  title: string;
  ownerAgentId: string;
  version: number;
  uri: string;
  preview: string | null;
  code: string | null;
  createdAt: string;
};

export type WorkflowSeat =
  | { ref: { kind: 'user' } }
  | { ref: { kind: 'role'; role: AgentRole; agentId?: string | undefined } };

export type QualityGateKind =
  | 'none'
  | 'requirement_clarification'
  | 'plan_approval'
  | 'handoff_acceptance'
  | 'test_failure_repair'
  | 'reviewer_signoff'
  | 'final_delivery_acceptance';

export type QualityGate = {
  kind: QualityGateKind;
  required: boolean;
  label: string;
  description: string;
  actions: string[];
};

export type WorkflowStage = {
  id: string;
  name: string;
  icon: string;
  kind: 'intake' | 'clarify' | 'plan' | 'work' | 'review' | 'repair' | 'ship';
  desc: string;
  seats: WorkflowSeat[];
  fixed?: boolean | undefined;
  parallelGroup?: string | undefined;
  gate: QualityGate;
  requiredInputs: string[];
  expectedOutputs: string[];
  requiredCapabilities: string[];
};

export type WorkflowTemplate = {
  id: string;
  name: string;
  tag: string | null;
  desc: string;
  builtin: boolean;
  version: number;
  updatedAt: string;
  planning: {
    cut: 'by_role' | 'by_capability' | 'by_artifact';
    clarifyThreshold: number;
    maxClarifyQuestions: number;
  };
  stages: WorkflowStage[];
};

export type AgentRole = 'planner' | 'pm' | 'architect' | 'implementer' | 'reviewer' | 'fixer';

export type AgentCard = {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: string[];
  skills: string[];
  preferredTaskTypes: string[];
  supportedArtifactTypes: ArtifactKind[];
  adapterMetadata: Record<string, string>;
  safetyConstraints: string[];
};

export type Handoff = {
  id: string;
  ownerId: string;
  chatId: string;
  card: Record<string, unknown>;
  createdAt: string;
};

export type HandoffCardV2 = {
  protocolVersion: 'roundtable.handoff.v2';
  cardId: string;
  missionId: string;
  sourceTaskId: string | null;
  referenceTaskIds: string[];
  fromAgent: string;
  toAgent: string;
  task: {
    id: string;
    title: string;
    brief: string;
    state: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  };
  contextPackage: {
    summary: string;
    includedArtifactIds: string[];
    omittedHistoryRef: string | null;
  };
  artifacts: Array<{ id: string; kind: ArtifactKind; title: string }>;
  nextAction: string;
  risks: string[];
  provenance: {
    generatedBy: string;
    generatedAt: string;
    agentCardSnapshot: AgentCard | null;
  };
};

export type UserProfile = {
  userId: string;
  defaultBrief: string;
  defaultSkills: string[];
  notes: string;
  updatedAt: string;
};

export type WorkbenchPin = {
  id: string;
  userId: string;
  workbenchId: string;
  content: string;
  createdAt: string;
};

export type Intake = {
  intentType: 'build' | 'review' | 'research' | 'fix';
  summary: string;
  clarity: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
};

// A clarifying question the planner asks when the request is too vague to plan.
// The user only picks an option (nocode-friendly); answers feed back into the plan.
export type ClarifyOption = {
  id: string;
  label: string;
  description?: string | undefined;
};

export type ClarifyQuestion = {
  id: string;
  question: string;
  options: ClarifyOption[];
};

export type ClarifyAnswer = {
  questionId: string;
  optionId: string;
  // The free-text label chosen, so the planner can read it directly.
  label: string;
};

export type PlanTask = {
  id: string;
  title: string;
  assignee: string;
  owner?: string | undefined;
  role?: string | undefined;
  stageId?: string | undefined;
  requiredCapabilities?: string[] | undefined;
  brief: string;
  deps: string[];
  parallel: boolean;
  // Optional scheduler hints. `priority` orders tasks inside a single wave
  // (lower first). `producedFor`/`fixRound` are only set on fixer tasks the
  // scheduler derives when an upstream task fails — they record which task is
  // being repaired and how many fix attempts have run for that branch.
  priority?: number | undefined;
  producedFor?: string | undefined;
  fixRound?: number | undefined;
};

export type Plan = {
  summary: string;
  tasks: PlanTask[];
};

export type AgentEvent =
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; output: Record<string, unknown>; isError?: boolean }
  | { type: 'file_change'; path: string; kind: 'create' | 'edit' | 'delete'; diff: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; message: string; recoverable: boolean };

export type DispatchRecord = {
  taskId: string;
  agentId: string;
  // 'blocked' is added for the DAG scheduler: a task whose (transitive) deps
  // failed is never executed and is recorded as blocked. Existing values are
  // kept unchanged so the UI status mapping (completed/failed/...) still works.
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  events: AgentEvent[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  // Set on fixer records derived by the scheduler: which task produced this
  // fix attempt, and how many fix rounds had run for that branch.
  producedFor?: string | undefined;
  fixRound?: number | undefined;
};

export type WorkflowStageRunStatus = 'pending' | 'active' | 'running' | 'done' | 'blocked' | 'failed';

export type WorkflowRun = {
  activeStageId: string | null;
  // Kept keyed by both task id and stage id for compatibility with the old
  // task-only UI and the newer Mission stage cards.
  stageStates: Record<string, {
    status: WorkflowStageRunStatus;
    taskIds?: string[] | undefined;
    artifactIds?: string[] | undefined;
    gate?: QualityGate | undefined;
    seatRuns?: Array<{
      agentId: string;
      status: WorkflowStageRunStatus;
      artifactIds: string[];
    }> | undefined;
  }>;
  taskStates: Record<string, { status: WorkflowStageRunStatus; stageId: string | null }>;
};

export type MissionStatus =
  | 'awaiting_clarification'
  | 'awaiting_approval'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed';

export type MissionStage = {
  id: string;
  name: string;
  status: WorkflowStageRunStatus;
  taskIds: string[];
  artifactIds: string[];
  gate: QualityGate;
};

export type MissionTask = {
  id: string;
  stageId: string | null;
  title: string;
  assignee: string;
  owner: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  deps: string[];
  artifactIds: string[];
};

export type MissionCheckpoint = {
  id: string;
  kind: QualityGateKind;
  label: string;
  status: 'pending' | 'satisfied' | 'blocked' | 'skipped';
  requiredAction: string | null;
  stageId: string;
  createdAt: string;
  resolvedAt: string | null;
};

export type MissionDecision = {
  id: string;
  stageId: string;
  actor: 'user' | 'reviewer' | 'orchestrator';
  summary: string;
  createdAt: string;
};

export type MissionFinalDelivery = {
  status: 'not_ready' | 'ready' | 'accepted' | 'rejected';
  reportArtifactId: string | null;
  recommendation: 'accept' | 'repair' | 'review';
};

export type Mission = {
  id: string;
  ownerId: string | null;
  chatId: string | null;
  sourceTurnId: string;
  goal: string;
  status: MissionStatus;
  workflowTemplateId: string;
  workflowTemplateName: string;
  currentStageId: string | null;
  stages: MissionStage[];
  tasks: MissionTask[];
  checkpoints: MissionCheckpoint[];
  decisions: MissionDecision[];
  artifactIds: string[];
  finalDelivery: MissionFinalDelivery;
  createdAt: string;
  updatedAt: string;
};

export type LocalTurn = {
  id: string;
  localChatId: string | null;
  ownerId: string | null;
  missionId: string;
  workflowTemplateId: string;
  message: string;
  status: 'pending' | 'done' | 'error';
  createdAt: string;
  provider: string;
  model: string;
  pmMessage: string;
  // Clarify gate: when the planner finds the request too vague it returns
  // questions and the turn pauses here (before dispatch) until the user answers.
  needsClarification: boolean;
  clarifyQuestions: ClarifyQuestion[];
  clarifyAnswers: ClarifyAnswer[];
  needsApproval: boolean;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  approvedAt: string | null;
  dispatchStatus: 'not_started' | 'running' | 'completed' | 'failed';
  dispatchAdapter: string | null;
  dispatchedAt: string | null;
  dispatchStage: string | null;
  dispatchError: string | null;
  dispatchWorkspacePath: string | null;
  dispatch: DispatchRecord[];
  artifacts: Artifact[];
  intake: Intake;
  plan: Plan;
  workflow: Record<string, unknown> | null;
  workflowRun: WorkflowRun | null;
  mission: Mission | null;
  error: string | null;
};
