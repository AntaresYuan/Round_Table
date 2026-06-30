import { z } from 'zod';
import { answerClarification } from '@/server/actions/turn-actions';
import { jsonError } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        optionId: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(1),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    return Response.json(await answerClarification(body));
  } catch (error) {
    return jsonError(error);
  }
}
