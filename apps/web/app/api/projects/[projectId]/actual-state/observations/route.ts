import type { NextRequest } from "next/server";
import { validateObservationIngestion } from "../../../../../../lib/validation/actual-state-ingestion.ts";
import { ingestObservation } from "../../../../../../lib/services/actual-state.ts";
import {
  errorResponse,
  malformedJsonResponse,
  nonObjectBodyResponse,
  toActualStateApiData,
} from "../../../../../../lib/api/actual-state-http.ts";

// NOTE (Work 78): This endpoint is currently unauthenticated. It is suitable
// only for local development and trusted environments. It must not be exposed
// publicly as a production ingestion interface without an authorization design.
// See docs/actual-state-ingestion.md §10.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return malformedJsonResponse();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return nonObjectBodyResponse();
  }

  const validation = validateObservationIngestion(body);
  if (!validation.valid || !validation.observation) {
    return Response.json(
      {
        success: false,
        error: "Actual State observation failed validation.",
        errors: validation.errors,
      },
      { status: 400 }
    );
  }

  try {
    const created = await ingestObservation({
      ...validation.observation,
      projectId,
    });
    return Response.json(
      { success: true, data: toActualStateApiData(created) },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
