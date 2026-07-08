import { z } from 'zod';
import { editTurnDelivery } from '@/server/actions/turn-actions';
import { jsonError, requireProductionActor } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
  instruction: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const actor = await requireProductionActor();
    return Response.json(await editTurnDelivery({ ...body, actor }));
  } catch (error) {
    return jsonError(error);
  }
}
