import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg';
import type {
  Artifact,
  AgentRuntimeConfig,
  AgentRuntimeConversation,
  AgentRuntimeDefaultConfig,
  Chat,
  Handoff,
  LocalTurn,
  Message,
  Mission,
  RoundtableSettings,
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
  agentRuntimeConfigs: AgentRuntimeConfig[];
  agentRuntimeDefaults: AgentRuntimeDefaultConfig[];
  agentRuntimeConversations: AgentRuntimeConversation[];
  settings: RoundtableSettings;
};

const { Pool } = pg;
const POSTGRES_TABLE = 'roundtable_store';
const DEFAULT_STORE_KEY = 'default';

let pool: PgPool | null = null;
let postgresReady: Promise<void> | null = null;

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
  if (usePostgresStore()) return readPostgresData();
  return readJsonData();
}

export async function writeData(data: RoundtableData): Promise<void> {
  if (usePostgresStore()) {
    await writePostgresData(data);
    return;
  }
  await writeJsonData(data);
}

export async function mutateData<T>(fn: (data: RoundtableData) => T | Promise<T>): Promise<T> {
  if (usePostgresStore()) return mutatePostgresData(fn);
  const data = await readJsonData();
  const result = await fn(data);
  await writeJsonData(data);
  return result;
}

export async function resetData(): Promise<void> {
  await writeData(emptyData());
}

async function readJsonData(): Promise<RoundtableData> {
  try {
    const raw = await readFile(dataPath(), 'utf8');
    return normalizeData(JSON.parse(raw) as Partial<RoundtableData>);
  } catch (error) {
    if (isNotFound(error)) return emptyData();
    throw error;
  }
}

async function writeJsonData(data: RoundtableData): Promise<void> {
  const target = dataPath();
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

async function readPostgresData(): Promise<RoundtableData> {
  await ensurePostgresStore();
  const result = await getPool().query<{ data: Partial<RoundtableData> }>(
    `SELECT data FROM ${POSTGRES_TABLE} WHERE id = $1`,
    [storeKey()],
  );
  return normalizeData(result.rows[0]?.data ?? {});
}

async function writePostgresData(data: RoundtableData): Promise<void> {
  await ensurePostgresStore();
  await getPool().query(
    `INSERT INTO ${POSTGRES_TABLE} (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [storeKey(), normalizeData(data)],
  );
}

async function mutatePostgresData<T>(fn: (data: RoundtableData) => T | Promise<T>): Promise<T> {
  await ensurePostgresStore();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await ensurePostgresRow(client);
    const result = await client.query<{ data: Partial<RoundtableData> }>(
      `SELECT data FROM ${POSTGRES_TABLE} WHERE id = $1 FOR UPDATE`,
      [storeKey()],
    );
    const data = normalizeData(result.rows[0]?.data ?? {});
    const output = await fn(data);
    await client.query(
      `UPDATE ${POSTGRES_TABLE} SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
      [storeKey(), data],
    );
    await client.query('COMMIT');
    return output;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensurePostgresStore(): Promise<void> {
  postgresReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${POSTGRES_TABLE} (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await getPool().query(
      `INSERT INTO ${POSTGRES_TABLE} (id, data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [storeKey(), emptyData()],
    );
  })().catch((error: unknown) => {
    postgresReady = null;
    throw error;
  });
  await postgresReady;
}

async function ensurePostgresRow(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO ${POSTGRES_TABLE} (id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [storeKey(), emptyData()],
  );
}

function getPool(): PgPool {
  if (!pool) {
    const max = Number(process.env.ROUNDTABLE_POSTGRES_POOL_SIZE || 10);
    const config: PoolConfig = { max: Number.isFinite(max) && max > 0 ? max : 10 };
    if (process.env.DATABASE_URL) config.connectionString = process.env.DATABASE_URL;
    pool = new Pool(config);
  }
  return pool;
}

function usePostgresStore(): boolean {
  const driver = process.env.ROUNDTABLE_STORE_DRIVER?.trim().toLowerCase();
  if (driver === 'postgres') return true;
  if (driver === 'json') return false;
  return process.env.NODE_ENV !== 'test' && Boolean(process.env.DATABASE_URL);
}

function storeKey(): string {
  return process.env.ROUNDTABLE_STORE_KEY?.trim() || DEFAULT_STORE_KEY;
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
    agentRuntimeConfigs: [],
    agentRuntimeDefaults: [],
    agentRuntimeConversations: [],
    settings: emptySettings(),
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
    agentRuntimeConfigs: Array.isArray(raw.agentRuntimeConfigs)
      ? raw.agentRuntimeConfigs.map(normalizeRuntimeConfig)
      : [],
    agentRuntimeDefaults: Array.isArray(raw.agentRuntimeDefaults)
      ? raw.agentRuntimeDefaults.map(normalizeRuntimeDefault)
      : [],
    agentRuntimeConversations: Array.isArray(raw.agentRuntimeConversations) ? raw.agentRuntimeConversations : [],
    settings: normalizeSettings(raw.settings),
  };
}

function normalizeRuntimeConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  return {
    ...config,
    modelProvider: config.modelProvider ?? null,
    interactionMode: config.interactionMode ?? null,
    effort: config.effort ?? null,
  };
}

function normalizeRuntimeDefault(config: AgentRuntimeDefaultConfig): AgentRuntimeDefaultConfig {
  return {
    ...config,
    modelProvider: config.modelProvider ?? null,
    interactionMode: config.interactionMode ?? null,
    effort: config.effort ?? null,
  };
}

function emptySettings(): RoundtableSettings {
  return {
    defaultAgentAdapter: null,
    modelProviders: [],
    updatedAt: nowIso(),
  };
}

function normalizeSettings(raw: Partial<RoundtableSettings> | undefined): RoundtableSettings {
  if (!raw || typeof raw !== 'object') return emptySettings();
  return {
    defaultAgentAdapter: typeof raw.defaultAgentAdapter === 'string' ? raw.defaultAgentAdapter : null,
    modelProviders: Array.isArray(raw.modelProviders) ? raw.modelProviders : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
