import './load-env.js';
import { id, mutateData, readData } from '../server/store.js';

if (!process.env.DATABASE_URL && process.env.ROUNDTABLE_STORE_DRIVER !== 'postgres') {
  throw new Error('Set DATABASE_URL or ROUNDTABLE_STORE_DRIVER=postgres before running the Postgres smoke check.');
}

process.env.ROUNDTABLE_STORE_DRIVER = 'postgres';

const marker = {
  id: id('user'),
  email: `smoke-${Date.now()}@roundtable.local`,
  name: 'Postgres Smoke',
  createdAt: new Date().toISOString(),
};

await mutateData((data) => {
  data.users.push(marker);
});

const data = await readData();
const found = data.users.some((user) => user.id === marker.id && user.email === marker.email);
if (!found) throw new Error('Postgres smoke marker was not persisted.');

process.stdout.write(`Postgres smoke check passed with store key ${process.env.ROUNDTABLE_STORE_KEY || 'default'}.\n`);
