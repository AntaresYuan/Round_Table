# Roundtable

Roundtable is a visual multi-agent workbench for planning, running, reviewing,
and shipping software tasks with a persistent AI squad.

![Roundtable workbench](https://cdn.jsdelivr.net/gh/EdwinjJ1/roundtable@main/docs/assets/readme/roundtable-workbench.png)

## What Is Roundtable?

Roundtable turns a plain-language request into a visible run. A planner breaks
work into dependent tasks, implementers work in parallel, reviewers gate quality,
and the final files, diffs, previews, comments, and handoffs stay attached to the
conversation.

## Highlights

- Persistent agent squad with planner, implementer, reviewer, architect, and
  fixer roles.
- Visual roundtable for live runs, handoffs, artifacts, review state, and chat.
- Dependency-aware scheduler that runs independent tasks in parallel.
- Bounded review and fixer loop for failed tasks or blocking safety findings.
- Local JSON storage for prototypes; normalized Postgres for shared runs.
- Shared server action layer for the Next app, REST routes, tRPC, and CLI.

## Screenshots

![Live roundtable](https://cdn.jsdelivr.net/gh/EdwinjJ1/roundtable@main/docs/assets/readme/live-roundtable.png)

![Parallel plan and artifacts](https://cdn.jsdelivr.net/gh/EdwinjJ1/roundtable@main/docs/assets/readme/parallel-plan-artifacts.png)

## Quick Start

```bash
corepack pnpm install
corepack pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). If that port is busy, Next
will print the alternate local URL.

Useful checks:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm cli workflow smoke --message "Build a waitlist page"
```

## How It Works

1. The user describes a goal.
2. The planner turns it into a dependency-aware task plan.
3. The scheduler runs every unlocked task in parallel waves.
4. Agents produce files, diffs, previews, review comments, and handoffs.
5. Safety or review failures create bounded fixer rounds.
6. The run finishes with artifacts and decisions preserved in the workbench.

## Project Shape

- `src/app/*` contains the Next.js app routes.
- `src/ui/components/*` contains the roundtable, workflow, chat, gallery, and
  inspector UI.
- `src/server/actions/*` contains business workflows shared by tRPC, REST route
  handlers, and the CLI.
- `src/server/store.ts` selects local JSON or Postgres persistence.
- `src/cli/*` contains smoke tests, migration helpers, and local database tools.

## Configuration

### Storage

Roundtable stores data in `.roundtable/data.json` by default. Set
`DATABASE_URL` to use Postgres. When a database URL is present, the production
default is the normalized driver:

```bash
DATABASE_URL=postgres://roundtable:roundtable@localhost:5432/roundtable \
ROUNDTABLE_STORE_DRIVER=postgres_normalized \
corepack pnpm dev
```

For a local Docker-backed database:

```bash
corepack pnpm db:up
corepack pnpm db:migrate:local
corepack pnpm db:smoke:local
corepack pnpm dev:postgres
```

To migrate existing local JSON data into Postgres:

```bash
DATABASE_URL=postgres://roundtable:roundtable@localhost:5432/roundtable \
corepack pnpm migrate:postgres
```

### Auth

Roundtable uses NextAuth. Production sign-in should use Google OAuth with a
verified Google email. The credentials provider is a local developer fallback.

Required production values:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
NEXTAUTH_URL=https://your-domain.com
NEXTAUTH_SECRET=...
```

Authorized Google redirect URIs:

- `http://localhost:3000/api/auth/callback/google`
- `https://your-domain.com/api/auth/callback/google`

### Agent Adapters

`local-dispatch` is the default deterministic adapter for development and CI.
Other adapters can run local CLIs, sandboxed E2B sessions, MiniMax, or
OpenAI-compatible providers.

| `ROUNDTABLE_AGENT_ADAPTER` | Behavior | Requires |
| --- | --- | --- |
| `local-dispatch` | Deterministic template output. | None |
| `agent-cli` / `claude-cli` / `opencode` | Spawns a local coding CLI. | `ROUNDTABLE_ENABLE_EXTERNAL_AGENT=1` |
| `e2b` | Runs the agent CLI inside an E2B sandbox. | `E2B_API_KEY` |
| `minimax` | Runs agents against MiniMax chat models. | `MINIMAX_API_KEY` |

Production workbenches default to
`ROUNDTABLE_WORKSPACE_ROOT/{ownerId}/{workbenchId}`. Custom workspace paths are
ignored in production unless `ROUNDTABLE_ALLOW_CUSTOM_WORKSPACE_PATH=1` is set
deliberately.

## Tech Stack

Next.js, React, tRPC, NextAuth, Vitest, Postgres, and pnpm.
