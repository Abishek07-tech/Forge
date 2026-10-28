import type { ExecutionJob } from "../../types/control-plane.ts";
import {
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneServiceError,
  InvalidJobTransitionServiceError,
} from "../services/control-plane.ts";

export interface ExecutionJobApiData {
  jobId: string;
  projectId: string;
  workloadId: string;
  desiredState: { desiredStateId: string; version: number };
  jobType: string;
  status: string;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  correlationId?: string;
  failure?: {
    kind: string;
    message: string;
    code?: string;
    occurredAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
  queuedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export function toExecutionJobApiData(job: ExecutionJob): ExecutionJobApiData {
  const data: ExecutionJobApiData = {
    jobId: job.jobId,
    projectId: job.projectId,
    workloadId: job.workloadId,
    desiredState: job.desiredState,
    jobType: job.jobType,
    status: job.status,
    idempotencyKey: job.idempotencyKey,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.correlationId !== undefined) {
    data.correlationId = job.correlationId;
  }
  if (job.failure !== undefined) {
    data.failure = job.failure;
  }
  if (job.queuedAt !== undefined) {
    data.queuedAt = job.queuedAt;
  }
  if (job.startedAt !== undefined) {
    data.startedAt = job.startedAt;
  }
  if (job.finishedAt !== undefined) {
    data.finishedAt = job.finishedAt;
  }
  return data;
}

interface ErrorBody {
  success: false;
  error: string;
  errors?: { path: string; message: string }[];
}

function errorJson(body: ErrorBody, status: number): Response {
  return Response.json(body, { status });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ControlPlaneNotFoundError) {
    return errorJson({ success: false, error: error.message }, 404);
  }
  if (
    error instanceof ControlPlaneConflictError ||
    error instanceof InvalidJobTransitionServiceError
  ) {
    return errorJson({ success: false, error: error.message }, 409);
  }
  if (error instanceof ControlPlaneServiceError) {
    if (error.code === "VALIDATION_FAILED") {
      return errorJson({ success: false, error: error.message }, 400);
    }
    console.error("Control Plane API: internal error", error);
    return errorJson(
      { success: false, error: "Internal server error." },
      500
    );
  }
  console.error("Control Plane API: unexpected error", error);
  return errorJson({ success: false, error: "Internal server error." }, 500);
}

export function malformedJsonResponse(): Response {
  return errorJson(
    { success: false, error: "Request body must be valid JSON." },
    400
  );
}

export function nonObjectBodyResponse(): Response {
  return errorJson(
    { success: false, error: "Request body must be a JSON object." },
    400
  );
}

export function invalidFieldsResponse(
  errors: { path: string; message: string }[]
): Response {
  return errorJson(
    {
      success: false,
      error: "Control Plane request failed validation.",
      errors,
    },
    400
  );
}
