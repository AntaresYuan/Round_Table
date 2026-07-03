import './load-env.js';
import { id, mutateData, readData } from '../server/store.js';

const targetDriver = process.env.ROUNDTABLE_STORE_DRIVER || 'postgres_normalized';

if (!['postgres', 'postgres_normalized', 'normalized'].includes(targetDriver)) {
  throw new Error('Set ROUNDTABLE_STORE_DRIVER to postgres or postgres_normalized before running the smoke check.');
}

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL before running the Postgres smoke check.');
}

process.env.ROUNDTABLE_STORE_DRIVER = targetDriver;

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

process.stdout.write(
  `Postgres smoke check passed with ${targetDriver} store key ${process.env.ROUNDTABLE_STORE_KEY || 'default'}.\n`,
);
