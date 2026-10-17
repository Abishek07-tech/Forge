import type {
  Application,
  Deployment,
  DesiredState,
  Environment,
  Health,
  Resources,
  Runtime,
} from "../../types/desired-state.ts";
import {
  DesiredStateConflictError,
  DesiredStateNotFoundError,
  DesiredStateServiceError,
  DesiredStateValidationFailedError,
  DuplicateVersionError,
  InvalidProjectError,
} from "../services/desired-state.ts";

export interface DesiredStateApiData {
  desiredStateId: string;
  projectId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  desiredState: {
    applications: Application;
    runtime: Runtime;
    resources: Resources;
    health: Health;
    environment?: Environment;
    deployment?: Deployment;
  };
}

export function toDesiredStateApiData(state: DesiredState): DesiredStateApiData {
  const desiredState: DesiredStateApiData["desiredState"] = {
    applications: state.applications,
    runtime: state.runtime,
    resources: state.resources,
    health: state.health,
  };
  if (state.environment !== undefined) {
    desiredState.environment = state.environment;
  }
  if (state.deployment !== undefined) {
    desiredState.deployment = state.deployment;
  }
  return {
    desiredStateId: state.desiredStateId,
    projectId: state.projectId,
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    desiredState,
  };
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
  if (error instanceof DesiredStateValidationFailedError) {
    return errorJson(
      {
        success: false,
        error: "Desired State failed validation.",
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
  if (error instanceof DesiredStateNotFoundError) {
    return errorJson({ success: false, error: error.message }, 404);
  }
  if (
    error instanceof DesiredStateConflictError ||
    error instanceof DuplicateVersionError
  ) {
    return errorJson(
      { success: false, error: error.message },
      409
    );
  }
  if (error instanceof DesiredStateServiceError) {
    console.error("Desired State API: internal error", error);
    return errorJson(
      { success: false, error: "Internal server error." },
      500
    );
  }
  console.error("Desired State API: unexpected error", error);
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

export function invalidVersionParamResponse(): Response {
  return errorJson(
    {
      success: false,
      error: "version must be a positive integer.",
    },
    400
  );
}

export function notFoundDesiredStateResponse(projectId: string): Response {
  return errorJson(
    {
      success: false,
      error: `Project "${projectId}" has no Desired State.`,
    },
    404
  );
}

export function notFoundVersionResponse(
  projectId: string,
  version: number
): Response {
  return errorJson(
    {
      success: false,
      error: `Desired State version ${version} does not exist for project "${projectId}".`,
    },
    404
  );
}
