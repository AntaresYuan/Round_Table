import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answerClarification, approveTurn, createTurn, interruptTurn } from '../src/server/actions/turn-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';
const actor: Actor = { id: 'test-user', email: 'test@roundtable.local', name: 'Test User' };

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-turn-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  process.env.ROUNDTABLE_AGENT_ADAPTER = 'local-dispatch';
  // Exercise dispatch directly; the clarify gate is covered in its own suite.
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
  delete process.env.ROUNDTABLE_MAX_FIX_ROUNDS;
  delete process.env.ROUNDTABLE_SAFETY_ENABLED;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  await rm(tempDir, { recursive: true, force: true });
});

describe('dispatchTurn — DAG scheduler integration', () => {
  it('runs a linear plan to completion with per-task stage states (shape, not order)', async () => {
    const turn = await createTurn({ actor, message: 'Build a waitlist page and review it.' });
    const result = await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    expect(result.dispatchStatus).toBe('completed');

    // Shape assertion: every planned task has a terminal record; deps are honored
    // (a task's record exists only if its deps completed). No ordering assumption.
    const byTask = Object.fromEntries(result.records.map((r) => [r.taskId, r.status]));
    for (const task of turn.plan.tasks) {
      expect(byTask[task.id]).toBe('completed');
    }
    const stageStates = result.workflowRun?.stageStates ?? {};
    for (const task of turn.plan.tasks) {
      expect(stageStates[task.id]?.status).toBe('done');
    }
  });

  it('blocks a high-severity finding and derives bounded fixer tasks', async () => {
    // Force every agent run to emit an OpenAI-style key via the external CLI
    // adapter (echo). The safety gate marks each task as a blocking failure,
    // which routes into the fix loop; fixers also emit the key, so the loop is
    // capped at ROUNDTABLE_MAX_FIX_ROUNDS.
    process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT = '1';
    process.env.ROUNDTABLE_AGENT_COMMAND = 'echo';
    process.env.ROUNDTABLE_AGENT_ARGS = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.ROUNDTABLE_MAX_FIX_ROUNDS = '2';

    const turn = await createTurn({ actor, message: '@atlas build the navbar.' });
    const result = await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    expect(result.dispatchStatus).toBe('failed');
    // Original task failed on safety, then up to 2 fixer attempts were derived.
    const failed = result.records.filter((r) => r.status === 'failed');
    const fixers = result.records.filter((r) => r.fixRound !== undefined);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(fixers.length).toBeGreaterThanOrEqual(1);
    expect(fixers.length).toBeLessThanOrEqual(2);
    expect(fixers.every((r) => (r.fixRound ?? 0) <= 2)).toBe(true);
  });

  it('does not block when safety is disabled', async () => {
    process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT = '1';
    process.env.ROUNDTABLE_AGENT_COMMAND = 'echo';
    process.env.ROUNDTABLE_AGENT_ARGS = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa';
    process.env.ROUNDTABLE_SAFETY_ENABLED = 'false';

    const turn = await createTurn({ actor, message: '@atlas build the navbar.' });
    const result = await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.records.every((r) => r.status === 'completed')).toBe(true);
  });

  it('does not keep final delivery blocked after a fixer repairs a blocking review', async () => {
    process.env.ROUNDTABLE_ENABLE_EXTERNAL_AGENT = '1';
    process.env.ROUNDTABLE_AGENT_COMMAND = 'echo';
    process.env.ROUNDTABLE_AGENT_ARGS = 'Looks good -- no blockers';
    process.env.ROUNDTABLE_AGENT_ARGS_REVIEWER = 'Critical: generated page is missing the checkout confirmation';
    process.env.ROUNDTABLE_AGENT_ARGS_FIXER = 'Fixed checkout confirmation and verified the repair';
    process.env.ROUNDTABLE_MAX_FIX_ROUNDS = '1';

    const turn = await createTurn({ actor, message: 'Build a checkout page and review it.' });
    const result = await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'agent-cli',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.records.some((r) => r.status === 'failed' && r.agentId === 'vera')).toBe(true);
    expect(result.records.some((r) => r.status === 'completed' && r.agentId === 'fixer' && r.producedFor)).toBe(true);
    expect(result.mission?.finalDelivery.confidence).not.toBe('blocked');
    expect(result.mission?.finalDelivery.recommendation).toBe('accept');
    expect(JSON.parse(result.artifacts.find((artifact) => artifact.id === `review_summary_${turn.id}`)?.preview ?? '{}')?.risks)
      .toEqual([]);
  });

  it('parks a vague request for clarification, then plans after the user answers', async () => {
    // Enable the clarify gate for this case (heuristic path, no model key).
    process.env.ROUNDTABLE_CLARIFY_ENABLED = 'true';

    const parked = await createTurn({ actor, message: 'make a website' });
    expect(parked.needsClarification).toBe(true);
    expect(parked.clarifyQuestions.length).toBeGreaterThan(0);
    expect(parked.plan.tasks).toHaveLength(0); // not planned yet

    const q = parked.clarifyQuestions[0]!;
    const opt = q.options[0]!;
    const resumed = await answerClarification({
      actor,
      turnId: parked.id,
      answers: [{ questionId: q.id, optionId: opt.id, label: opt.label }],
    });

    expect(resumed.needsClarification).toBe(false);
    expect(resumed.plan.tasks.length).toBeGreaterThan(0); // now planned
    expect(resumed.clarifyAnswers).toHaveLength(1);
  });

  it('syncs Mission state when a turn is interrupted', async () => {
    const turn = await createTurn({ actor, message: 'Build a waitlist page and review it.' });
    await approveTurn({ turnId: turn.id, decision: 'approve' });
    const interrupted = await interruptTurn(turn.id);

    expect(interrupted.dispatchStage).toBe('interrupted');
    expect(interrupted.mission?.status).toBe('failed');
    expect(interrupted.workflowRun).not.toBeNull();
  });
});
