import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChat, createMessage } from '../src/server/actions/chat-actions.js';
import { normalizeAdapter } from '../src/server/actions/agent-runner.js';
import { approveTurn, createTurn, listTurns } from '../src/server/actions/turn-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';

const actor: Actor = {
  id: 'test-user',
  email: 'test@roundtable.local',
  name: 'Test User',
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-clean-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  process.env.ROUNDTABLE_AGENT_ADAPTER = 'local-dispatch';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  delete process.env.ROUNDTABLE_AGENT_COMMAND;
  delete process.env.ROUNDTABLE_AGENT_ARGS;
  delete process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT;
  delete process.env.ROUNDTABLE_ALLOW_CLAUDE_CLI;
  await rm(tempDir, { recursive: true, force: true });
});

describe('Roundtable clean workflow', () => {
  it('creates a chat, plans a turn, approves dispatch, and records artifacts', async () => {
    const workbench = await createWorkbench(actor, {
      name: 'Workflow test',
      workspacePath: 'workspaces/test',
    });
    const chat = await createChat(actor, {
      workbenchId: workbench.id,
      title: 'Build a waitlist',
    });
    await createMessage(actor, {
      chatId: chat.id,
      content: 'Build a waitlist page and review it.',
    });

    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a waitlist page and review it.',
    });
    expect(turn.approvalStatus).toBe('approved');
    expect(turn.needsApproval).toBe(false);
    expect(turn.plan.tasks).toHaveLength(3);
    expect(turn.plan.tasks[0]?.owner).toBe('orchestrator');
    expect(turn.plan.tasks.map((task) => task.owner)).toContain('atlas');
    expect(turn.plan.tasks.map((task) => task.owner)).toContain('vera');
    expect(turn.plan.tasks.every((task) => Array.isArray(task.deps))).toBe(true);
    expect(turn.plan.tasks.every((task) => typeof task.parallel === 'boolean')).toBe(true);

    const approval = await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    expect(approval.dispatchStatus).toBe('completed');
    expect(approval.records).toHaveLength(3);
    expect(approval.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(approval.workspacePath).toContain('workspaces/test');
    expect(approval.artifacts.find((artifact) => artifact.id.startsWith('task_vera_'))?.preview)
      .toContain('Previous agent output');

    const history = await listTurns(chat.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.dispatchStatus).toBe('completed');
  });

  it('routes explicit mentions to the named agent instead of the whole table', async () => {
    const turn = await createTurn({
      actor,
      message: '@atlas implement the navbar interaction.',
    });

    expect(turn.plan.tasks).toHaveLength(1);
    expect(turn.plan.tasks[0]?.owner).toBe('atlas');
    expect(turn.plan.tasks[0]?.assignee).toBe('@atlas');
    expect(turn.approvalStatus).toBe('approved');
  });

  it('defaults unmentioned backend work to planning, backend implementation, and review', async () => {
    const turn = await createTurn({
      actor,
      message: 'Build an API endpoint for user login and review it.',
    });

    expect(turn.plan.tasks.map((task) => task.owner)).toEqual(['orchestrator', 'beam', 'vera']);
    expect(turn.plan.tasks[1]?.deps).toEqual(['task_planning']);
    expect(turn.plan.tasks[2]?.deps).toEqual(['task_beam']);
  });

  it('ignores stale external adapter requests unless explicitly enabled', () => {
    process.env.ROUNDTABLE_AGENT_ADAPTER = 'local-dispatch';
    delete process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT;

    expect(normalizeAdapter('claude-cli')).toBe('local-dispatch');
    expect(normalizeAdapter('claude-code')).toBe('local-dispatch');

    process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT = '1';
    expect(normalizeAdapter('claude-cli')).toBe('agent-cli');
    expect(normalizeAdapter('agent-cli')).toBe('agent-cli');
  });

  it('can dispatch through an explicitly enabled external CLI command adapter', async () => {
    process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT = '1';
    process.env.ROUNDTABLE_AGENT_COMMAND = 'printf';
    process.env.ROUNDTABLE_AGENT_ARGS = '{prompt}';

    const workbench = await createWorkbench(actor, {
      name: 'External adapter test',
      workspacePath: 'workspaces/external',
    });
    const chat = await createChat(actor, {
      workbenchId: workbench.id,
      title: 'External CLI',
    });
    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Use the external command adapter.',
    });

    const approval = await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    expect(approval.dispatchAdapter).toBe('agent-cli');
    expect(approval.dispatchStatus).toBe('completed');
    expect(approval.records.every((record) => record.events.some((event) => event.type === 'tool_use'))).toBe(true);
  });
});
