import type { NextRequest } from "next/server";
import type { DesiredState } from "../../../../../types/desired-state.ts";
import {
  createDesiredState,
  getCurrentDesiredState,
  updateDesiredState,
} from "../../../../../lib/services/desired-state.ts";
import {
  errorResponse,
  malformedJsonResponse,
  nonObjectBodyResponse,
  notFoundDesiredStateResponse,
  toDesiredStateApiData,
} from "../../../../../lib/api/desired-state-http.ts";

async function readDeclaration(
  request: NextRequest,
  projectId: string
): Promise<DesiredState | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return malformedJsonResponse();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return nonObjectBodyResponse();
  }
  return { ...(body as Record<string, unknown>), projectId } as DesiredState;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const declaration = await readDeclaration(request, projectId);
  if (declaration instanceof Response) {
    return declaration;
  }
  try {
    const created = await createDesiredState(declaration);
    return Response.json(
      { success: true, data: toDesiredStateApiData(created) },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  try {
    const current = await getCurrentDesiredState(projectId);
    if (!current) {
      return notFoundDesiredStateResponse(projectId);
    }
    return Response.json({
      success: true,
      data: toDesiredStateApiData(current),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const declaration = await readDeclaration(request, projectId);
  if (declaration instanceof Response) {
    return declaration;
  }
  try {
    const updated = await updateDesiredState(projectId, declaration);
    return Response.json({
      success: true,
      data: toDesiredStateApiData(updated),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
