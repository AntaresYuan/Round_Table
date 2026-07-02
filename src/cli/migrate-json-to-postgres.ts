import { readFile } from 'node:fs/promises';
import './load-env.js';
import { dataPath, writeData } from '../server/store.js';

const source = process.argv[2] || dataPath();

if (!process.env.DATABASE_URL && process.env.ROUNDTABLE_STORE_DRIVER !== 'postgres') {
  throw new Error('Set DATABASE_URL or ROUNDTABLE_STORE_DRIVER=postgres before running this migration.');
}

process.env.ROUNDTABLE_STORE_DRIVER = 'postgres';

const raw = await readFile(source, 'utf8');
await writeData(JSON.parse(raw));

process.stdout.write(`Migrated ${source} to Postgres store key ${process.env.ROUNDTABLE_STORE_KEY || 'default'}.\n`);
