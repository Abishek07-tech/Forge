import type { NextRequest } from "next/server";
import { listJobs } from "../../../../../../lib/services/control-plane.ts";
import { errorResponse } from "../../../../../../lib/api/control-plane-http.ts";

// NOTE (Work 97): This endpoint is currently unauthenticated, matching the
// project's existing API policy. Local development / trusted environments only.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const url = new URL(request.url);

  const workloadId = url.searchParams.get("workloadId") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const jobType = url.searchParams.get("jobType") ?? undefined;
  const limit = url.searchParams.get("limit") ?? undefined;
  const offset = url.searchParams.get("offset") ?? undefined;

  try {
    const result = await listJobs(projectId, {
      workloadId,
      status,
      jobType,
      limit,
      offset,
    });
    return Response.json({ success: true, data: result }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
