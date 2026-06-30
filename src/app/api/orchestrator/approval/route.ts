import { z } from 'zod';
import { approveTurn } from '@/server/actions/turn-actions';
import { jsonError } from '@/server/route-utils';

const BodySchema = z.object({
  turnId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  autoDispatch: z.boolean().optional(),
  agentAdapter: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    // From the web client, always run dispatch in the background so the approve
    // call returns immediately and the UI can poll live per-agent progress.
    return Response.json(await approveTurn({ ...body, background: true }));
  } catch (error) {
    return jsonError(error);
  }
}
