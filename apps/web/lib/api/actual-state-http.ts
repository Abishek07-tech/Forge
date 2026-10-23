import type {
  ActualStateObservation,
  Environment,
  ObservedApplication,
  ObservedDeployment,
  ObservedHealth,
  ObservedResources,
  ObservedRuntime,
} from "../../types/actual-state.ts";
import {
  ActualStateConflictError,
  ActualStateNotFoundError,
  ActualStateServiceError,
  ActualStateValidationFailedError,
  InvalidProjectError,
} from "../services/actual-state.ts";

export interface ActualStateApiData {
  observationId: string;
  projectId: string;
  workloadId: string;
  source: string;
  observedAt: Date;
  status: ActualStateObservation["status"];
  createdAt?: Date;
  observation: {
    application: ObservedApplication;
    runtime: ObservedRuntime;
    resources: ObservedResources;
    health: ObservedHealth;
    environment?: Environment;
    deployment?: ObservedDeployment;
  };
}

export function toActualStateApiData(
  observation: ActualStateObservation,
  createdAt?: Date
): ActualStateApiData {
  const payload: ActualStateApiData["observation"] = {
    application: observation.application,
    runtime: observation.runtime,
    resources: observation.resources,
    health: observation.health,
  };
  if (observation.environment !== undefined) {
    payload.environment = observation.environment;
  }
  if (observation.deployment !== undefined) {
    payload.deployment = observation.deployment;
  }
  const data: ActualStateApiData = {
    observationId: observation.observationId,
    projectId: observation.projectId,
    workloadId: observation.workloadId,
    source: observation.source,
    observedAt: observation.observedAt,
    status: observation.status,
    observation: payload,
  };
  if (createdAt !== undefined) {
    data.createdAt = createdAt;
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
  if (error instanceof ActualStateValidationFailedError) {
    return errorJson(
      {
        success: false,
        error: "Actual State observation failed validation.",
        errors: error.validationErrors,
      },
      400
    );
  }
  if (error instanceof InvalidProjectError) {
    return errorJson(
      { success: false, error: "Project not found." },
      404
    );
  }
  if (error instanceof ActualStateNotFoundError) {
    return errorJson({ success: false, error: error.message }, 404);
  }
  if (error instanceof ActualStateConflictError) {
    return errorJson(
      { success: false, error: error.message },
      409
    );
  }
  if (error instanceof ActualStateServiceError) {
    console.error("Actual State API: internal error", error);
    return errorJson(
      { success: false, error: "Internal server error." },
      500
    );
  }
  console.error("Actual State API: unexpected error", error);
  return errorJson(
    { success: false, error: "Internal server error." },
    500
  );
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
