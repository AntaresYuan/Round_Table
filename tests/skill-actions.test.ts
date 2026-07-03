import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChat } from '../src/server/actions/chat-actions.js';
import { pinWorkbench } from '../src/server/actions/memory-actions.js';
import { setUserSkillEnabled, upsertUserSkill } from '../src/server/actions/skill-actions.js';
import { createTurn } from '../src/server/actions/turn-actions.js';
import { createWorkbench } from '../src/server/actions/workbench-actions.js';
import { resetData } from '../src/server/store.js';
import type { Actor } from '../src/server/types.js';

let tempDir = '';

const actor: Actor = {
  id: 'skills-user',
  email: 'skills@roundtable.local',
  name: 'Skills User',
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'roundtable-skills-'));
  process.env.ROUNDTABLE_DATA_PATH = join(tempDir, 'data.json');
  process.env.ROUNDTABLE_WORKSPACE_ROOT = join(tempDir, 'workspaces');
  process.env.ROUNDTABLE_CLARIFY_ENABLED = 'false';
  await resetData();
});

afterEach(async () => {
  delete process.env.ROUNDTABLE_DATA_PATH;
  delete process.env.ROUNDTABLE_WORKSPACE_ROOT;
  delete process.env.ROUNDTABLE_CLARIFY_ENABLED;
  await rm(tempDir, { recursive: true, force: true });
});

describe('User skills', () => {
  it('injects enabled skills and workbench rules into planned turns', async () => {
    const workbench = await createWorkbench(actor, {
      name: 'Skills test',
      workspacePath: 'workspaces/skills-test',
    });
    const chat = await createChat(actor, {
      workbenchId: workbench.id,
      title: 'Build settings',
    });
    await upsertUserSkill(actor, {
      key: 'plan_before_implementation',
      source: 'observed',
      evidence: 'User wants a plan before changes.',
    });
    await setUserSkillEnabled(actor, {
      key: 'plan_before_implementation',
      enabled: false,
    });
    const updatedSkill = await upsertUserSkill(actor, {
      key: 'plan_before_implementation',
      evidence: 'Updated evidence should not override disabled state.',
    });
    await setUserSkillEnabled(actor, {
      key: 'plan_before_implementation',
      enabled: true,
    });
    await pinWorkbench(actor, {
      workbenchId: workbench.id,
      content: 'Show visual approval before marking UI work done.',
    });

    const turn = await createTurn({
      actor,
      chatId: chat.id,
      message: 'Build a profile settings UI and review it.',
    });

    expect(updatedSkill.enabled).toBe(false);
    expect(turn.mission?.workingStyle.skills.map((skill) => skill.key)).toContain('plan_before_implementation');
    expect(turn.mission?.workingStyle.projectRules).toContain('Show visual approval before marking UI work done.');
    expect(turn.plan.tasks[0]?.brief).toContain('Plan before implementation');
    expect(turn.artifacts.find((artifact) => artifact.id === `intake_${turn.id}`)?.preview)
      .toContain('Show visual approval before marking UI work done.');
  });

  it('only injects mission-scoped skills into the targeted chat', async () => {
    const workbench = await createWorkbench(actor, {
      name: 'Mission skill test',
      workspacePath: 'workspaces/mission-skill-test',
    });
    const targetChat = await createChat(actor, {
      workbenchId: workbench.id,
      title: 'Target mission',
    });
    const otherChat = await createChat(actor, {
      workbenchId: workbench.id,
      title: 'Other mission',
    });
    const missionSkill = await upsertUserSkill(actor, {
      key: 'visual_approval_required',
      scope: 'mission',
      targetChatId: targetChat.id,
      source: 'recommended',
      evidence: 'Enabled from the recommended mission section.',
    });

    const targetTurn = await createTurn({
      actor,
      chatId: targetChat.id,
      message: 'Build a polished landing page UI.',
    });
    const otherTurn = await createTurn({
      actor,
      chatId: otherChat.id,
      message: 'Build a polished landing page UI.',
    });

    expect(missionSkill.scope).toBe('mission');
    expect(missionSkill.targetChatId).toBe(targetChat.id);
    expect(targetTurn.mission?.workingStyle.skills.map((skill) => skill.key)).toContain('visual_approval_required');
    expect(otherTurn.mission?.workingStyle.skills.map((skill) => skill.key)).not.toContain('visual_approval_required');
  });
});
