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

Set `ROUNDTABLE_AGENT_ADAPTER=claude-cli` to run the configured local CLI during dispatch. The default `local-dispatch` adapter is deterministic and suitable for devrt verification.
