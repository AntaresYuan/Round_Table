import { z } from 'zod';
import { decideTurnFinalDelivery } from '@/server/actions/turn-actions';
import { jsonError } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
  decision: z.enum(['accept', 'repair', 'tests']),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    return Response.json(await decideTurnFinalDelivery(body));
  } catch (error) {
    return jsonError(error);
  }
}
