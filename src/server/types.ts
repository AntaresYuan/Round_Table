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
  status: 'pending' | 'running' | 'completed' | 'failed';
  events: AgentEvent[];
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

export type WorkflowRun = {
  stageStates: Record<string, { status: 'pending' | 'running' | 'done' | 'blocked' }>;
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
