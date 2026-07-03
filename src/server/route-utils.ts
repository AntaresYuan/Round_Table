import { getServerSession } from 'next-auth';
import { authOptions, type AuthSession } from './auth.js';
import { ActionError } from './actions/turn-actions.js';
import type { Actor } from './types.js';

export async function routeActor(): Promise<Actor | null> {
  const session = (await getServerSession(authOptions)) as AuthSession | null;
  return session?.user ?? null;
}

export function jsonError(error: unknown): Response {
  if (error instanceof ActionError) {
    return Response.json({ ok: false, error: error.code }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'unauthorized') {
    return Response.json({ ok: false, error: message }, { status: 401 });
  }
  const status = knownClientError(message) ? 400 : 500;
  return Response.json({ ok: false, error: message }, { status });
}

function knownClientError(message: string): boolean {
  return [
    'missing_message',
    'missing_workbench_name',
    'missing_chat_title',
    'missing_message_content',
    'workbench_not_found',
    'chat_not_found',
    'mission_not_found',
    'handoff_not_found',
    'handoff_not_rejectable',
    'unauthorized',
  ].includes(message);
}
