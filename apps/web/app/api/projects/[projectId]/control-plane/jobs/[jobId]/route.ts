import type { NextRequest } from "next/server";
import {
  ControlPlaneNotFoundError,
  getExecutionJob,
} from "../../../../../../../lib/services/control-plane.ts";
import {
  errorResponse,
  toExecutionJobApiData,
} from "../../../../../../../lib/api/control-plane-http.ts";

// NOTE (Work 97): This endpoint is currently unauthenticated, matching the
// project's existing API policy. Local development / trusted environments only.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; jobId: string }> }
) {
  const { projectId, jobId } = await params;

  try {
    const job = await getExecutionJob(jobId);
    // A job may only be read through its owning project's route.
    if (job.projectId !== projectId) {
      throw new ControlPlaneNotFoundError(
        `Execution job "${jobId}" does not exist.`
      );
    }
    return Response.json(
      { success: true, data: toExecutionJobApiData(job) },
      { status: 200 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
