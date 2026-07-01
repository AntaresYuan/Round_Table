import { resolve } from 'node:path';
import { id, mutateData, nowIso, readData } from '../store.js';
import type { Actor, Workbench } from '../types.js';

export type CreateWorkbenchInput = {
  name: string;
  workspacePath?: string | undefined;
  description?: string | null | undefined;
};

export async function listWorkbenches(actor: Actor): Promise<Workbench[]> {
  const data = await readData();
  return data.workbenches
    .filter((workbench) => workbench.ownerId === actor.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createWorkbench(actor: Actor, input: CreateWorkbenchInput): Promise<Workbench> {
  const name = input.name.trim();
  if (!name) throw new Error('missing_workbench_name');
  return mutateData((data) => {
    const now = nowIso();
    const workbench: Workbench = {
      id: id('wb'),
      ownerId: actor.id,
      name,
      workspacePath: input.workspacePath?.trim() || defaultWorkspacePath(),
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    data.workbenches.push(workbench);
    return workbench;
  });
}

function defaultWorkspacePath(): string {
  return resolve(process.env.ROUNDTABLE_DEFAULT_WORKSPACE || process.cwd());
}

export async function getWorkbench(actor: Actor, workbenchId: string): Promise<Workbench | null> {
  const data = await readData();
  return data.workbenches.find((workbench) => workbench.ownerId === actor.id && workbench.id === workbenchId) ?? null;
}
