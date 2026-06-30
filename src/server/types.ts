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

export type Handoff = {
  id: string;
  ownerId: string;
  chatId: string;
  card: Record<string, unknown>;
  createdAt: string;
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

export type PlanTask = {
  id: string;
  title: string;
  assignee: string;
  owner?: string | undefined;
  role?: string | undefined;
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

export type WorkflowRun = {
  // Per-task state keyed by task id. 'failed' is added so a per-task DAG run can
  // distinguish a task that errored from one that was blocked by an upstream
  // failure; the UI's STAGE_STATUS_STYLE already renders all of these.
  stageStates: Record<string, { status: 'pending' | 'running' | 'done' | 'blocked' | 'failed' }>;
};

export type LocalTurn = {
  id: string;
  localChatId: string | null;
  ownerId: string | null;
  message: string;
  status: 'pending' | 'done' | 'error';
  createdAt: string;
  provider: string;
  model: string;
  pmMessage: string;
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
  error: string | null;
};
