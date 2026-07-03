import { isAbsolute, relative, resolve } from 'node:path';
import { id, mutateData, nowIso } from '../store.js';
import type { Actor, Workbench } from '../types.js';

export type CreateWorkbenchInput = {
  name: string;
  workspacePath?: string | undefined;
  description?: string | null | undefined;
};

export async function listWorkbenches(actor: Actor): Promise<Workbench[]> {
  return mutateData((data) =>
    data.workbenches
      .filter((workbench) => workbench.ownerId === actor.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
}

export async function createWorkbench(actor: Actor, input: CreateWorkbenchInput): Promise<Workbench> {
  const name = input.name.trim();
  if (!name) throw new Error('missing_workbench_name');
  return mutateData((data) => {
    const now = nowIso();
    const workbenchId = id('wb');
    const workbench: Workbench = {
      id: workbenchId,
      ownerId: actor.id,
      name,
      workspacePath: workspacePathForWorkbench(actor.id, workbenchId, input.workspacePath),
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    data.workbenches.push(workbench);
    return workbench;
  });
}

export function workspacePathForWorkbench(ownerId: string, workbenchId: string, requestedPath?: string | undefined): string {
  const candidate = requestedPath?.trim();
  if (candidate && customWorkspacePathsAllowed()) return resolve(candidate);
  return defaultWorkspacePath(ownerId, workbenchId);
}

export function storedWorkspacePath(workbench: Workbench): string {
  const resolved = resolve(workbench.workspacePath);
  if (customWorkspacePathsAllowed() || isPathInside(workspaceRoot(), resolved)) return resolved;
  return defaultWorkspacePath(workbench.ownerId, workbench.id);
}

function defaultWorkspacePath(ownerId: string, workbenchId: string): string {
  return resolve(workspaceRoot(), ownerId, workbenchId);
}

function workspaceRoot(): string {
  return resolve(process.env.ROUNDTABLE_WORKSPACE_ROOT || '.roundtable/workspaces');
}

function customWorkspacePathsAllowed(): boolean {
  return process.env.ROUNDTABLE_ALLOW_CUSTOM_WORKSPACE_PATH === '1' || process.env.NODE_ENV !== 'production';
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function getWorkbench(actor: Actor, workbenchId: string): Promise<Workbench | null> {
  return mutateData((data) =>
    data.workbenches.find((workbench) => workbench.ownerId === actor.id && workbench.id === workbenchId) ?? null,
  );
}
