import { id, mutateData, readData, nowIso } from '../store.js';
import type {
  Actor,
  UserSkill,
  UserSkillScope,
  UserSkillSource,
  WorkingStyleSnapshot,
} from '../types.js';

export type SkillInput = {
  key: string;
  label?: string | undefined;
  description?: string | undefined;
  source?: UserSkillSource | undefined;
  scope?: UserSkillScope | undefined;
  targetChatId?: string | null | undefined;
  evidence?: string | null | undefined;
  enabled?: boolean | undefined;
};

export type SuggestedSkill = {
  key: string;
  label: string;
  description: string;
  source: UserSkillSource;
  scope: UserSkillScope;
  reason: string;
  evidence: string;
};

const SKILL_CATALOG: Record<string, { label: string; description: string }> = {
  plan_before_implementation: {
    label: 'Plan before implementation',
    description: 'Create and review a short plan before agents edit files.',
  },
  visual_approval_required: {
    label: 'Visual approval required',
    description: 'For UI changes, show screenshots or previews before calling the work done.',
  },
  verify_before_push: {
    label: 'Verify before push',
    description: 'Run relevant checks such as typecheck, lint, build, or tests before pushing.',
  },
  concise_prd_style: {
    label: 'Concise PRD style',
    description: 'Keep PRDs short, flow-focused, and implementation-useful.',
  },
  accessibility_qa: {
    label: 'Accessibility QA',
    description: 'Check interaction states, labels, focus behavior, and readable contrast on UI work.',
  },
  github_visibility_preferred: {
    label: 'GitHub visibility preferred',
    description: 'Surface reviewable issues and changes through GitHub PRs or comments when useful.',
  },
};

const DEFAULT_SUGGESTIONS: SuggestedSkill[] = [
  {
    key: 'plan_before_implementation',
    ...SKILL_CATALOG.plan_before_implementation!,
    source: 'observed',
    scope: 'personal',
    reason: 'Useful when you want control before code changes start.',
    evidence: 'You asked to plan UI changes before implementation.',
  },
  {
    key: 'visual_approval_required',
    ...SKILL_CATALOG.visual_approval_required!,
    source: 'observed',
    scope: 'personal',
    reason: 'Useful for product/UI work where taste and screenshots matter.',
    evidence: 'You repeatedly asked to inspect UI screenshots before accepting changes.',
  },
  {
    key: 'verify_before_push',
    ...SKILL_CATALOG.verify_before_push!,
    source: 'recommended',
    scope: 'personal',
    reason: 'Avoids shipping PRs that fail basic checks.',
    evidence: 'Common high-leverage engineering workflow skill.',
  },
];

export function recommendedMissionSkills(context = ''): SuggestedSkill[] {
  const lower = context.toLowerCase();
  const picks = new Set<string>();
  if (/\b(ui|visual|frontend|css|screen|screenshot|页面|界面|登录|注册)\b/i.test(lower)) {
    picks.add('visual_approval_required');
    picks.add('accessibility_qa');
  }
  if (/\b(pr|github|ci|vercel|push|merge|review)\b/i.test(lower)) {
    picks.add('verify_before_push');
    picks.add('github_visibility_preferred');
  }
  if (/\b(prd|spec|requirement|flow|需求)\b/i.test(lower)) picks.add('concise_prd_style');
  if (picks.size === 0) picks.add('plan_before_implementation');
  return [...picks].map((keyValue) => ({
    key: keyValue,
    ...catalogEntry(keyValue),
    source: 'recommended' as const,
    scope: 'mission' as const,
    reason: 'Recommended for the current mission context.',
    evidence: 'Matched against the active mission or recent task text.',
  }));
}

export async function listUserSkills(actor: Actor): Promise<UserSkill[]> {
  return mutateData((data) => {
    materializeProfileSkills(data, actor.id);
    return data.userSkills
      .filter((skill) => skill.userId === actor.id)
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label));
  });
}

export async function listSuggestedSkills(actor: Actor): Promise<SuggestedSkill[]> {
  const existing = await listUserSkills(actor);
  const existingKeys = new Set(existing.map((skill) => skill.key));
  return DEFAULT_SUGGESTIONS.filter((skill) => !existingKeys.has(skill.key));
}

export async function upsertUserSkill(actor: Actor, input: SkillInput): Promise<UserSkill> {
  const keyValue = normalizeKey(input.key);
  if (!keyValue) throw new Error('missing_skill_key');
  const scope = input.scope ?? 'personal';
  const targetChatId = scope === 'mission' ? input.targetChatId?.trim() || null : null;
  return mutateData((data) => {
    materializeProfileSkills(data, actor.id);
    const now = nowIso();
    let skill = data.userSkills.find((item) =>
      item.userId === actor.id
      && item.key === keyValue
      && item.scope === scope
      && (item.targetChatId ?? null) === targetChatId);
    const catalog = catalogEntry(keyValue);
    if (!skill) {
      skill = {
        id: id('skill'),
        userId: actor.id,
        key: keyValue,
        label: input.label?.trim() || catalog.label,
        description: input.description?.trim() || catalog.description,
        source: input.source ?? 'user',
        scope,
        targetChatId,
        enabled: input.enabled ?? true,
        evidence: input.evidence ?? null,
        createdAt: now,
        updatedAt: now,
      };
      data.userSkills.push(skill);
    } else {
      skill.label = input.label?.trim() || skill.label || catalog.label;
      skill.description = input.description?.trim() || skill.description || catalog.description;
      skill.source = input.source ?? skill.source;
      skill.scope = scope;
      skill.targetChatId = targetChatId;
      skill.enabled = input.enabled ?? skill.enabled;
      skill.evidence = input.evidence ?? skill.evidence;
      skill.updatedAt = now;
    }
    syncProfileDefaultSkills(data, actor.id);
    return skill;
  });
}

export async function setUserSkillEnabled(actor: Actor, input: { key: string; enabled: boolean; scope?: UserSkillScope | undefined; targetChatId?: string | null | undefined }): Promise<UserSkill> {
  const keyValue = normalizeKey(input.key);
  const scope = input.scope ?? 'personal';
  const targetChatId = scope === 'mission' ? input.targetChatId?.trim() || null : null;
  return mutateData((data) => {
    materializeProfileSkills(data, actor.id);
    const skill = data.userSkills.find((item) =>
      item.userId === actor.id
      && item.key === keyValue
      && item.scope === scope
      && (item.targetChatId ?? null) === targetChatId);
    if (!skill) throw new Error('skill_not_found');
    skill.enabled = input.enabled;
    skill.updatedAt = nowIso();
    syncProfileDefaultSkills(data, actor.id);
    return skill;
  });
}

export async function deleteUserSkill(actor: Actor, input: { key: string; scope?: UserSkillScope | undefined; targetChatId?: string | null | undefined }): Promise<{ key: string }> {
  const key = input.key;
  const keyValue = normalizeKey(key);
  const scope = input.scope ?? 'personal';
  const targetChatId = scope === 'mission' ? input.targetChatId?.trim() || null : null;
  return mutateData((data) => {
    data.userSkills = data.userSkills.filter((skill) => !(
      skill.userId === actor.id
      && skill.key === keyValue
      && skill.scope === scope
      && (skill.targetChatId ?? null) === targetChatId
    ));
    syncProfileDefaultSkills(data, actor.id);
    return { key: keyValue };
  });
}

export async function getWorkingStyleSnapshot(
  actor: Actor | null | undefined,
  chatId?: string | null | undefined,
): Promise<WorkingStyleSnapshot> {
  if (!actor) return emptyWorkingStyle();
  const data = await readData();
  const skills = data.userSkills
    .filter((skill) =>
      skill.userId === actor.id
      && skill.enabled
      && (skill.scope !== 'mission' || (skill.targetChatId ?? null) === (chatId ?? null)))
    .map((skill) => ({
      key: skill.key,
      label: skill.label,
      description: skill.description,
      source: skill.source,
      scope: skill.scope,
    }));
  const profile = data.profiles.find((item) => item.userId === actor.id);
  for (const keyValue of profile?.defaultSkills ?? []) {
    if (!skills.some((skill) => skill.key === normalizeKey(keyValue))) {
      const catalog = catalogEntry(keyValue);
      skills.push({
        key: normalizeKey(keyValue),
        label: catalog.label,
        description: catalog.description,
        source: 'user',
        scope: 'personal',
      });
    }
  }
  const chat = chatId ? data.chats.find((item) => item.id === chatId && item.ownerId === actor.id) : null;
  const projectRules = chat
    ? data.workbenchPins
        .filter((pin) => pin.userId === actor.id && pin.workbenchId === chat.workbenchId)
        .map((pin) => pin.content)
    : [];
  return { skills, projectRules };
}

export function emptyWorkingStyle(): WorkingStyleSnapshot {
  return { skills: [], projectRules: [] };
}

function materializeProfileSkills(data: { profiles: Array<{ userId: string; defaultSkills: string[] }>; userSkills: UserSkill[] }, userId: string): void {
  const profile = data.profiles.find((item) => item.userId === userId);
  for (const raw of profile?.defaultSkills ?? []) {
    const keyValue = normalizeKey(raw);
    if (!keyValue || data.userSkills.some((skill) => skill.userId === userId && skill.key === keyValue)) continue;
    const now = nowIso();
    const catalog = catalogEntry(keyValue);
    data.userSkills.push({
      id: id('skill'),
      userId,
      key: keyValue,
      label: catalog.label,
      description: catalog.description,
      source: 'user',
      scope: 'personal',
      targetChatId: null,
      enabled: true,
      evidence: null,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function syncProfileDefaultSkills(data: { profiles: Array<{ userId: string; defaultSkills: string[]; updatedAt: string }>; userSkills: UserSkill[] }, userId: string): void {
  const profile = data.profiles.find((item) => item.userId === userId);
  if (!profile) return;
  profile.defaultSkills = data.userSkills
    .filter((skill) => skill.userId === userId && skill.enabled && skill.scope === 'personal')
    .map((skill) => skill.key);
  profile.updatedAt = nowIso();
}

function catalogEntry(key: string): { label: string; description: string } {
  const keyValue = normalizeKey(key);
  return SKILL_CATALOG[keyValue] ?? {
    label: keyValue.split('_').map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(' '),
    description: 'Custom working style skill.',
  };
}

function normalizeKey(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
