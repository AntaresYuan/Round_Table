import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  Artifact,
  Chat,
  Handoff,
  LocalTurn,
  Message,
  Mission,
  UserProfile,
  Workbench,
  WorkbenchPin,
} from './types.js';

export type RoundtableData = {
  version: 1;
  users: Array<{ id: string; email: string; name: string | null; createdAt: string }>;
  workbenches: Workbench[];
  chats: Chat[];
  messages: Message[];
  artifacts: Artifact[];
  handoffs: Handoff[];
  profiles: UserProfile[];
  workbenchPins: WorkbenchPin[];
  turns: LocalTurn[];
  missions: Mission[];
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function dataPath(): string {
  return resolve(process.env.ROUNDTABLE_DATA_PATH || '.roundtable/data.json');
}

export async function readData(): Promise<RoundtableData> {
  try {
    const raw = await readFile(dataPath(), 'utf8');
    return normalizeData(JSON.parse(raw) as Partial<RoundtableData>);
  } catch (error) {
    if (isNotFound(error)) return emptyData();
    throw error;
  }
}

export async function writeData(data: RoundtableData): Promise<void> {
  const target = dataPath();
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

export async function mutateData<T>(fn: (data: RoundtableData) => T | Promise<T>): Promise<T> {
  const data = await readData();
  const result = await fn(data);
  await writeData(data);
  return result;
}

export async function resetData(): Promise<void> {
  await writeData(emptyData());
}

function emptyData(): RoundtableData {
  return {
    version: 1,
    users: [],
    workbenches: [],
    chats: [],
    messages: [],
    artifacts: [],
    handoffs: [],
    profiles: [],
    workbenchPins: [],
    turns: [],
    missions: [],
  };
}

function normalizeData(raw: Partial<RoundtableData>): RoundtableData {
  return {
    version: 1,
    users: Array.isArray(raw.users) ? raw.users : [],
    workbenches: Array.isArray(raw.workbenches) ? raw.workbenches : [],
    chats: Array.isArray(raw.chats) ? raw.chats : [],
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    handoffs: Array.isArray(raw.handoffs) ? raw.handoffs : [],
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    workbenchPins: Array.isArray(raw.workbenchPins) ? raw.workbenchPins : [],
    turns: Array.isArray(raw.turns) ? raw.turns : [],
    missions: Array.isArray(raw.missions) ? raw.missions : [],
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
