import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChat } from '../src/server/actions/chat-actions.js';
import {
  getMission,
  getMissionByTurn,
  listMissions,
  listWorkflowTemplates,
  selectWorkflowTemplate,
} from '../src/server/actions/mission-actions.js';
import { approveTurn, createTurn, decideTurnFinalDelivery, editTurnDelivery } from '../src/server/actions/turn-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';

const actor: Actor = {
  id: 'test-user',
  email: 'test@roundtable.local',
  name: 'Test User',
};

const otherActor: Actor = {
  id: 'other-user',
  email: 'other@roundtable.local',
  name: 'Other User',
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
  it('exposes typed built-in workflow templates for the backend', async () => {
    const templates = await listWorkflowTemplates();
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

  it('selects non-English workflow templates without relying on word boundaries', () => {
    expect(selectWorkflowTemplate('修复登录报错问题').id).toBe('wf-bug-fixer');
    expect(selectWorkflowTemplate('熟悉这个代码库架构').id).toBe('wf-codebase-onboarding');
  });

  it('creates a Mission from a turn and advances it through dispatch', async () => {
    const workbench = await createWorkbench(actor, { name: 'Mission test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Mission test' });
    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a full stack profile settings feature and review it.',
    });

    expect(turn.mission?.status).toBe('awaiting_approval');
    expect(turn.workflow?.['id']).toBe('wf-feature-builder');
    expect(turn.workflowRun?.activeStageId).toBe('plan');
    expect(turn.plan.tasks[0]?.stageId).toBe('plan');
    expect(turn.plan.tasks.some((task) => task.stageId === 'build')).toBe(true);

    const missionsBefore = await listMissions(actor, chat.id);
    expect(missionsBefore).toHaveLength(1);
    expect(missionsBefore[0]?.id).toBe(turn.missionId);
    expect(await getMission(actor, turn.missionId)).toMatchObject({ id: turn.missionId });
    expect(await getMissionByTurn(actor, turn.id)).toMatchObject({ id: turn.missionId });
    expect(await listMissions(otherActor, chat.id)).toHaveLength(0);
    expect(await getMission(otherActor, turn.missionId)).toBeNull();
    expect(await getMissionByTurn(otherActor, turn.id)).toBeNull();

    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    expect(result.dispatchStatus).toBe('completed');
    expect(result.mission?.status).toBe('completed');
    expect(result.mission?.finalDelivery.status).toBe('ready');
    // Report artifacts are chat-scoped so follow-up turns replace them in place.
    expect(result.mission?.finalDelivery.reportArtifactId).toBe(`final_report_${chat.id}`);
    expect(result.mission?.finalDelivery.confidence).toBe('pass');
    expect(result.mission?.finalDelivery.testsObserved).toBe(true);
    expect(result.artifacts.find((artifact) => artifact.id === `final_report_${chat.id}`)?.preview)
      .toContain('Final Delivery Report');
    expect(JSON.parse(result.artifacts.find((artifact) => artifact.id === `review_summary_${chat.id}`)?.preview ?? '{}')?.confidence)
      .toBe('pass');
    expect(result.workflowRun?.stageStates.plan?.status).toBe('done');
    expect(result.workflowRun?.stageStates.build?.status).toBe('done');
    expect(result.workflowRun?.stageStates.review?.status).toBe('done');
    expect(result.workflowRun?.stageStates.ship?.status).toBe('done');
    expect(result.workflowRun?.activeStageId).toBe('ship');
    expect(result.workflowRun?.stageStates.build?.seatRuns).toHaveLength(1);
    expect(result.workflowRun?.stageStates.build?.seatRuns?.every((seat) => seat.status === 'done')).toBe(true);
    expect(result.mission?.artifactIds.length).toBeGreaterThan(0);

    const testsRequested = await decideTurnFinalDelivery({ actor, turnId: turn.id, decision: 'tests' });
    expect(testsRequested.mission?.finalDelivery.status).toBe('ready');
    expect(testsRequested.mission?.finalDelivery.recommendation).toBe('review');
    expect(testsRequested.mission?.checkpoints.find((checkpoint) => checkpoint.kind === 'final_delivery_acceptance')?.status)
      .toBe('pending');
    expect(testsRequested.mission?.tasks.some((task) => task.id === `test_final_${turn.id}` && task.stageId === 'review'))
      .toBe(true);
    const testsRequestedAgain = await decideTurnFinalDelivery({ actor, turnId: turn.id, decision: 'tests' });
    expect(testsRequestedAgain.mission?.tasks.filter((task) => task.id === `test_final_${turn.id}`)).toHaveLength(1);

    const repairRequested = await decideTurnFinalDelivery({ actor, turnId: turn.id, decision: 'repair' });
    expect(repairRequested.mission?.currentStageId).toBe('ship');
    expect(repairRequested.workflowRun?.stageStates.repair?.status).toBe('done');
    expect(repairRequested.mission?.tasks.some((task) => task.id === `repair_final_${turn.id}` && task.status === 'completed'))
      .toBe(true);
    expect(repairRequested.records.some((record) => record.taskId === `repair_final_${turn.id}` && record.status === 'completed'))
      .toBe(true);
    expect(repairRequested.artifacts.some((artifact) => artifact.id === `repair_final_${turn.id}_${turn.id}`))
      .toBe(true);
    expect(repairRequested.mission?.finalDelivery.status).toBe('ready');
    expect(repairRequested.mission?.finalDelivery.confidence).not.toBe('blocked');
    const repairRequestedAgain = await decideTurnFinalDelivery({ actor, turnId: turn.id, decision: 'repair' });
    expect(repairRequestedAgain.mission?.tasks.filter((task) => task.id === `repair_final_${turn.id}`)).toHaveLength(1);

    const accepted = await decideTurnFinalDelivery({ actor, turnId: turn.id, decision: 'accept' });
    expect(accepted.mission?.finalDelivery.status).toBe('accepted');
    expect(accepted.mission?.checkpoints.find((checkpoint) => checkpoint.kind === 'final_delivery_acceptance')?.status)
      .toBe('satisfied');
  });

  it('produces a concrete checkout delivery artifact for checkout flow requests', async () => {
    const workbench = await createWorkbench(actor, { name: 'Checkout test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Checkout test' });
    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Implement a checkout flow with cart summary, payment handoff, validation, and post-payment confirmation.',
    });

    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    const delivery = result.artifacts.find((artifact) => artifact.kind === 'preview');
    expect(result.records.some((record) => record.agentId === 'fixer')).toBe(false);
    expect(result.workflowRun?.stageStates.repair?.status).toBe('pending');
    expect(delivery?.preview).toContain('Cart summary');
    expect(delivery?.preview).toContain('Payment handoff');
    expect(delivery?.preview).toContain('Post-payment confirmation');
    expect(delivery?.preview).toContain('ZIP must be 5 digits');
  });

  it('applies follow-up color edits to the current delivery artifact', async () => {
    const workbench = await createWorkbench(actor, { name: 'Checkout edit test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Checkout edit test' });
    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Implement a checkout flow with cart summary, payment handoff, validation, and post-payment confirmation.',
    });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });
    const before = result.artifacts.find((artifact) => artifact.kind === 'preview');

    const edited = await editTurnDelivery({ actor, turnId: turn.id, instruction: '不错，换个颜色' });
    const after = edited.artifacts.find((artifact) => artifact.id === before?.id);

    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.preview).toContain('--accent:#0f766e');
    expect(after?.preview).toContain('data-roundtable-edit="palette-teal"');
    expect(edited.records.some((record) => record.taskId.startsWith(`edit_${turn.id}`))).toBe(true);
  });

  it('does not pretend vague complaints are artifact edits', async () => {
    const workbench = await createWorkbench(actor, { name: 'Checkout complaint test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'Checkout complaint test' });
    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Implement a checkout flow with cart summary, payment handoff, validation, and post-payment confirmation.',
    });
    await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    await expect(editTurnDelivery({ actor, turnId: turn.id, instruction: '啥也没有，你啥也没给我产出' }))
      .rejects.toThrow('edit_not_understood');
  });

  it('does not edit reports or code when no visible delivery artifact exists', async () => {
    const workbench = await createWorkbench(actor, { name: 'API edit test' });
    const chat = await createChat(actor, { workbenchId: workbench.id, title: 'API edit test' });
    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build an API endpoint for user login and review it.',
    });
    const result = await approveTurn({
      actor,
      turnId: turn.id,
      decision: 'approve',
      autoDispatch: true,
      agentAdapter: 'local-dispatch',
    });

    expect(result.artifacts.some((artifact) => artifact.kind === 'preview')).toBe(false);
    await expect(editTurnDelivery({ actor, turnId: turn.id, instruction: '换个颜色' }))
      .rejects.toThrow('artifact_not_ready');
  });
});
