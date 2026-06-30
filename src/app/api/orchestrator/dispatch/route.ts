import { z } from 'zod';
import { dispatchTurn } from '@/server/actions/turn-actions';
import { jsonError } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
  agentAdapter: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    return Response.json(await dispatchTurn(body));
  } catch (error) {
    return jsonError(error);
  }
}
