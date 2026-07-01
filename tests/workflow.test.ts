import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChat, createMessage } from '../src/server/actions/chat-actions.js';
import { normalizeAdapter } from '../src/server/actions/agent-runner.js';
import { listHandoffsByChat } from '../src/server/actions/read-actions.js';
import { answerClarification, approveTurn, createTurn, listTurns, reviewSeverities } from '../src/server/actions/turn-actions.js';
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
  // These tests exercise the build/dispatch pipeline directly, not the clarify
  // gate — disable clarification so plans are produced immediately.
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
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
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
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
    // A freshly-planned turn waits for the user to review and approve before any
    // agent runs.
    expect(turn.approvalStatus).toBe('pending');
    expect(turn.needsApproval).toBe(true);
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
    expect(approval.artifacts.find((artifact) => artifact.id.startsWith('task_vera_'))?.preview)
      .toContain('HandoffCard V2');

    const history = await listTurns(chat.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.dispatchStatus).toBe('completed');

    const handoffs = await listHandoffsByChat(actor, chat.id);
    expect(handoffs.filter((handoff) => handoff.card?.['protocolVersion'] === 'roundtable.handoff.v2').length)
      .toBeGreaterThanOrEqual(turn.plan.tasks.length);
  });

  it('gives each task a distinct title that excludes the clarification block', async () => {
    // Run the clarify gate so the message gets enriched with a "Clarified
    // requirements" block, then verify task titles stay short and don't all
    // repeat that same block.
    process.env.ROUNDTABLE_CLARIFY_ENABLED = 'true';
    delete process.env.MINIMAX_API_KEY; // force the deterministic heuristic

    const parked = await createTurn({ actor, message: 'make a website' });
    expect(parked.needsClarification).toBe(true);

    const planned = await answerClarification({
      turnId: parked.id,
      answers: parked.clarifyQuestions.map((q) => ({
        questionId: q.id,
        optionId: q.options[0]!.id,
        label: q.options[0]!.label,
      })),
    });

    const titles = planned.plan.tasks.map((task) => task.title);
    // No title leaks the clarification block.
    expect(titles.every((title) => !title.includes('Clarified requirements'))).toBe(true);
    // The three steps read distinctly (Plan… / Build… / Review…), not identical.
    expect(new Set(titles).size).toBe(titles.length);
    // But the full enriched goal still lives in each brief for the agents.
    expect(planned.plan.tasks[0]?.brief).toContain('Clarified requirements');
  });

  it('shows downstream tasks as placeholders before the plan, then concrete titles after', async () => {
    const turn = await createTurn({
      actor,
      message: '生成一个镜头测评网站',
    });

    // Plan-time: only the planner knows the goal. Build/Review are placeholders
    // that await the plan — they must NOT pre-fill the user's request.
    const planTitles = turn.plan.tasks.map((task) => task.title);
    expect(planTitles[0]).toContain('生成一个镜头测评网站'); // the Plan task names the goal
    const build = turn.plan.tasks.find((task) => task.role === 'implementer');
    const review = turn.plan.tasks.find((task) => task.role === 'reviewer');
    expect(build?.title).toMatch(/awaiting plan/i);
    expect(review?.title).not.toContain('生成一个镜头测评网站');

    await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    // After the planner runs, the plan defines the work — downstream tasks get
    // concrete, named titles (no longer "awaiting plan").
    const after = (await listTurns()).find((t) => t.id === turn.id);
    const buildAfter = after?.plan.tasks.find((task) => task.role === 'implementer');
    const reviewAfter = after?.plan.tasks.find((task) => task.role === 'reviewer');
    expect(buildAfter?.title).not.toMatch(/awaiting plan/i);
    expect(buildAfter?.title).toContain('生成一个镜头测评网站');
    expect(reviewAfter?.title).toContain('生成一个镜头测评网站');
  });

  it('routes explicit mentions to the named agent instead of the whole table', async () => {
    const turn = await createTurn({
      actor,
      message: '@atlas implement the navbar interaction.',
    });

    expect(turn.plan.tasks).toHaveLength(1);
    expect(turn.plan.tasks[0]?.owner).toBe('atlas');
    expect(turn.plan.tasks[0]?.assignee).toBe('@atlas');
    expect(turn.approvalStatus).toBe('pending');
  });

  it('detects blocking review findings (so a review triggers a fix) and passes a clean review', () => {
    const bad = reviewSeverities('### 🔴 Critical\n1. images broken\n### 🟠 High\n- slow load');
    expect(bad.blocking).toBeGreaterThan(0);

    const badZh = reviewSeverities('## 严重问题\n- 图片无法显示（致命）');
    expect(badZh.blocking).toBeGreaterThan(0);

    const clean = reviewSeverities('Looks good — no blockers, ready to ship.');
    expect(clean.blocking).toBe(0);

    const cleanZh = reviewSeverities('整体没有问题，可以直接交付。');
    expect(cleanZh.blocking).toBe(0);
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
