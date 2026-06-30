# Roundtable Clean Backend

This is a clean Roundtable implementation that keeps the existing frontend and replaces the backend with a small action layer.

## Shape

- `src/server/actions/*` contains business workflows.
- tRPC routes, REST route handlers, and the CLI all call the same actions.
- Data is stored locally in `.roundtable/data.json`.
- `devrt` scenarios verify real product workflows through the CLI action surface.

## Commands

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm typecheck
corepack pnpm test
corepack pnpm cli workflow smoke --message "Build a waitlist page"
```

## Dispatch: DAG scheduler

`dispatchTurn` runs a turn's plan through a topological (Kahn-wave) scheduler
(`src/server/actions/scheduler.ts`):

1. **Parallel waves** — every task whose `deps` are all completed runs together
   (`Promise.allSettled`); the next wave unlocks as deps finish.
2. **Dependency gating** — a task runs only when it has no deps, or all its deps
   have completed. Cycles are rejected before anything runs.
3. **Failure propagation** — a failed task blocks its transitive dependents while
   independent branches finish.
4. **Review → fix loop** — an agent error *or* a blocking safety finding turns a
   task into a failure, which derives a fixer task (bounded by
   `ROUNDTABLE_MAX_FIX_ROUNDS`, default `2`).

The safety layer (`src/server/actions/safety.ts`) scans every artifact (including
fixer output) for secrets and dangerous code; high-severity findings block.

## Adapter matrix

| `ROUNDTABLE_AGENT_ADAPTER` | Behavior | Requires |
| --- | --- | --- |
| `local-dispatch` (default) | Deterministic template output; used by devrt/CI. | — |
| `agent-cli` / `claude-cli` / `opencode` | Spawns a local coding CLI in the workspace. | `ROUNDTABLE_ENABLE_EXTERNAL_AGENT=1` |
| `e2b` | Runs the agent CLI inside an E2B sandbox. Falls back to `local-dispatch` (logged) if the key is missing. | `E2B_API_KEY` |

```bash
ROUNDTABLE_AGENT_ADAPTER=local-dispatch corepack pnpm cli workflow smoke --message "Build a waitlist page"
```

Relevant env vars: `ROUNDTABLE_AGENT_ADAPTER`, `ROUNDTABLE_MAX_FIX_ROUNDS`,
`ROUNDTABLE_SAFETY_ENABLED`, `E2B_API_KEY` (see `.env.example`).
