import { z } from 'zod';
import { createTurn, dispatchTurn } from '@/server/actions/turn-actions';
import { jsonError, routeActor } from '@/server/route-utils';

const BodySchema = z.object({
  message: z.string().min(1),
  turnId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  agentAdapter: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const actor = await routeActor();
    const turn = await createTurn({ ...body, actor });
    // Parked for clarification — return the questions and wait for the user's
    // answers (POST /clarify) before any planning or dispatch happens.
    if (turn.needsClarification) {
      return Response.json(turn);
    }
    const dispatch = await dispatchTurn({ turnId: turn.id, agentAdapter: body.agentAdapter });
    return Response.json({
      ...turn,
      needsApproval: dispatch.needsApproval,
      approvalStatus: dispatch.approvalStatus,
      approvedAt: dispatch.approvedAt,
      dispatchStatus: dispatch.dispatchStatus,
      dispatchAdapter: dispatch.dispatchAdapter,
      dispatchedAt: dispatch.dispatchedAt,
      dispatchStage: dispatch.dispatchStage,
      dispatchError: dispatch.dispatchError,
      dispatchWorkspacePath: dispatch.workspacePath,
      dispatch: dispatch.records,
      artifacts: dispatch.artifacts,
      workflowRun: dispatch.workflowRun,
    });
  } catch (error) {
    return jsonError(error);
  }
}
