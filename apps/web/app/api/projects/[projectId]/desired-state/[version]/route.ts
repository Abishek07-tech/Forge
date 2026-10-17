import type { NextRequest } from "next/server";
import { getDesiredStateByVersion } from "../../../../../../lib/services/desired-state.ts";
import {
  errorResponse,
  invalidVersionParamResponse,
  notFoundVersionResponse,
  toDesiredStateApiData,
} from "../../../../../../lib/api/desired-state-http.ts";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; version: string }> }
) {
  const { projectId, version } = await params;
  const parsedVersion = Number(version);
  if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
    return invalidVersionParamResponse();
  }
  try {
    const state = await getDesiredStateByVersion(projectId, parsedVersion);
    if (!state) {
      return notFoundVersionResponse(projectId, parsedVersion);
    }
    return Response.json({
      success: true,
      data: toDesiredStateApiData(state),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
