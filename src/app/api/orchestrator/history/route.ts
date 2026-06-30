import { listTurns } from '@/server/actions/turn-actions';
import { jsonError } from '@/server/route-utils';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const chatId = url.searchParams.get('chatId') ?? undefined;
    return Response.json({ ok: true, turns: await listTurns(chatId) });
  } catch (error) {
    return jsonError(error);
  }
}
