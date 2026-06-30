import { z } from 'zod';
import { interruptTurn } from '@/server/actions/turn-actions';
import { jsonError } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    return Response.json(await interruptTurn(body.turnId));
  } catch (error) {
    return jsonError(error);
  }
}
