import type { NextRequest } from "next/server";
import { evaluateResourceAndRequestExecution } from "../../../../../../lib/services/control-plane.ts";
import {
  errorResponse,
  invalidFieldsResponse,
  malformedJsonResponse,
  nonObjectBodyResponse,
} from "../../../../../../lib/api/control-plane-http.ts";

// NOTE (Work 97): This endpoint is currently unauthenticated, matching the
// project's existing API policy (see docs/actual-state-ingestion.md §10).
// It is suitable only for local development and trusted environments.

interface EvaluateFields {
  workloadId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}

function validateFields(
  body: Record<string, unknown>
): { valid: true; fields: EvaluateFields } | { valid: false; errors: { path: string; message: string }[] } {
  const errors: { path: string; message: string }[] = [];
  const fields: EvaluateFields = {};

  for (const key of ["workloadId", "idempotencyKey", "correlationId"] as const) {
    const value = body[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      errors.push({
        path: key,
        message: `${key} must be a non-empty string when present`,
      });
      continue;
    }
    fields[key] = value;
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return { valid: true, fields };
}

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

  const validation = validateFields(body as Record<string, unknown>);
  if (!validation.valid) {
    return invalidFieldsResponse(validation.errors);
  }

  try {
    const outcome = await evaluateResourceAndRequestExecution(projectId, {
      workloadId: validation.fields.workloadId,
      idempotencyKey: validation.fields.idempotencyKey,
      correlationId: validation.fields.correlationId,
    });
    // 200 with an explicit outcome: an execution request being recorded is
    // NOT an infrastructure change (no execution mechanism exists yet).
    return Response.json({ success: true, data: outcome }, { status: 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
