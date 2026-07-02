import { listRuntimeState } from '@/server/actions/runtime-actions';
import { jsonError } from '@/server/route-utils';

export async function GET() {
  try {
    return Response.json({ ok: true, state: await listRuntimeState() });
  } catch (error) {
    return jsonError(error);
  }
}
