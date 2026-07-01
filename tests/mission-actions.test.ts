import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listMissions, listWorkflowTemplates } from '../src/server/actions/mission-actions.js';
import { approveTurn, createTurn } from '../src/server/actions/turn-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';

const actor: Actor = {
  id: 'test-user',
  email: 'test@roundtable.local',
  name: 'Test User',
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-mission-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  process.env.ROUNDTABLE_AGENT_ADAPTER = 'local-dispatch';
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
  delete process.env.ROUNDTABLE_AGENT_ADAPTER;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  await rm(tempDir, { recursive: true, force: true });
});

describe('Mission P0 migration', () => {
  it('exposes typed built-in workflow templates for the backend', () => {
    const templates = listWorkflowTemplates();
    expect(templates.map((template) => template.id)).toContain('wf-feature-builder');
    const featureBuilder = templates.find((template) => template.id === 'wf-feature-builder');
    expect(featureBuilder?.stages.map((stage) => stage.id)).toEqual([
      'intake',
      'clarify',
      'plan',
      'build',
      'review',
      'repair',
      'ship',
    ]);
    expect(featureBuilder?.stages.find((stage) => stage.id === 'plan')?.gate.kind).toBe('plan_approval');
    expect(featureBuilder?.stages.find((stage) => stage.id === 'review')?.requiredCapabilities).toContain('review.quality_gate');
  });

  it('creates a Mission from a turn and advances it through dispatch', async () => {
    const turn = await createTurn({
      actor,
      chatId: 'mission-chat',
      message: 'Build a full stack profile settings feature and review it.',
    });

    expect(turn.mission?.status).toBe('awaiting_approval');
    expect(turn.workflow?.['id']).toBe('wf-feature-builder');
    expect(turn.workflowRun?.activeStageId).toBe('plan');
    expect(turn.plan.tasks[0]?.stageId).toBe('plan');
    expect(turn.plan.tasks.some((task) => task.stageId === 'build')).toBe(true);

    const missionsBefore = await listMissions('mission-chat');
    expect(missionsBefore).toHaveLength(1);
    expect(missionsBefore[0]?.id).toBe(turn.missionId);

    const result = await approveTurn({
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.mission?.status).toBe('completed');
    expect(result.mission?.finalDelivery.status).toBe('ready');
    expect(result.mission?.finalDelivery.reportArtifactId).toBe(`final_report_${turn.id}`);
    expect(result.artifacts.find((artifact) => artifact.id === `final_report_${turn.id}`)?.preview)
      .toContain('Final Delivery Report');
    expect(result.workflowRun?.stageStates.plan?.status).toBe('done');
    expect(result.workflowRun?.stageStates.review?.status).toBe('done');
    expect(result.workflowRun?.stageStates.ship?.status).toBe('active');
    expect(result.mission?.artifactIds.length).toBeGreaterThan(0);
  });
});
