import { normalizeAdapter } from '@/server/actions/agent-runner';

export async function GET() {
  return Response.json({
    ok: true,
    backend: 'clean-action-layer',
    defaultAdapter: normalizeAdapter(undefined),
    cliCommand: process.env.ROUNDTABLE_AGENT_COMMAND || 'claude',
  });
}
