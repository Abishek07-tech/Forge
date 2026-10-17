import type { DesiredState } from "../../types/desired-state.ts";
import {
  validateDesiredState,
  type ValidationError,
} from "../validation/desired-state.ts";
import {
  createDesiredState as createDesiredStateInPersistence,
  getCurrentDesiredState as getCurrentDesiredStateInPersistence,
  getDesiredStateByVersion as getDesiredStateByVersionInPersistence,
  listDesiredStateVersions as listDesiredStateVersionsInPersistence,
  DesiredStatePersistenceError,
  DuplicateDesiredStateIdError,
  DuplicateVersionError,
  InvalidProjectError,
} from "../persistence/desired-state.ts";

export type DesiredStateServiceErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PERSISTENCE_FAILED";

export class DesiredStateServiceError extends Error {
  readonly code: DesiredStateServiceErrorCode;
  readonly errors: ValidationError[];
  readonly causeError: unknown;

  constructor(
    code: DesiredStateServiceErrorCode,
    message: string,
    errors: ValidationError[] = [],
    causeError?: unknown
  ) {
    super(message);
    this.name = "DesiredStateServiceError";
    this.code = code;
    this.errors = errors;
    this.causeError = causeError;
  }
}

export class DesiredStateValidationFailedError extends DesiredStateServiceError {
  readonly validationErrors: ValidationError[];

  constructor(validationErrors: ValidationError[]) {
    super(
      "VALIDATION_FAILED",
      "Desired State failed validation.",
      validationErrors
    );
    this.name = "DesiredStateValidationFailedError";
    this.validationErrors = validationErrors;
  }
}

export class DesiredStateNotFoundError extends DesiredStateServiceError {
  constructor(message = "The requested Desired State does not exist for the project.") {
    super("NOT_FOUND", message);
    this.name = "DesiredStateNotFoundError";
  }
}

export class DesiredStateConflictError extends DesiredStateServiceError {
  constructor(message: string, causeError?: unknown) {
    super("CONFLICT", message, [], causeError);
    this.name = "DesiredStateConflictError";
  }
}

export function ensureValidDesiredState(
  input: unknown
): asserts input is DesiredState {
  const result = validateDesiredState(input);
  if (!result.valid) {
    throw new DesiredStateValidationFailedError(result.errors);
  }
}

export async function createDesiredState(
  input: DesiredState
): Promise<DesiredState> {
  ensureValidDesiredState(input);
  try {
    return await createDesiredStateInPersistence(input);
  } catch (error) {
    if (error instanceof DuplicateDesiredStateIdError) {
      throw new DesiredStateConflictError(
        "A Desired State with this desiredStateId already exists.",
        error
      );
    }
    if (error instanceof DesiredStatePersistenceError) {
      throw error;
    }
    throw new DesiredStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to persist Desired State.",
      [],
      error
    );
  }
}

export async function updateDesiredState(
  projectId: string,
  next: DesiredState
): Promise<DesiredState> {
  ensureValidDesiredState(next);
  const current = await getCurrentDesiredStateInPersistence(projectId);
  if (!current) {
    throw new DesiredStateNotFoundError(
      `Project "${projectId}" has no Desired State to update.`
    );
  }
  if (next.desiredStateId === current.desiredStateId) {
    throw new DesiredStateConflictError(
      `desiredStateId "${current.desiredStateId}" is already used by the current version; each version must declare a distinct desiredStateId.`
    );
  }
  const nextVersion: DesiredState = {
    ...next,
    projectId,
    version: current.version + 1,
  };
  try {
    return await createDesiredStateInPersistence(nextVersion);
  } catch (error) {
    if (error instanceof DuplicateDesiredStateIdError) {
      throw new DesiredStateConflictError(
        "A Desired State with this desiredStateId already exists.",
        error
      );
    }
    if (error instanceof DesiredStatePersistenceError) {
      throw error;
    }
    throw new DesiredStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to persist the new Desired State version.",
      [],
      error
    );
  }
}

export async function getCurrentDesiredState(
  projectId: string
): Promise<DesiredState | null> {
  try {
    return await getCurrentDesiredStateInPersistence(projectId);
  } catch (error) {
    throw new DesiredStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to read the current Desired State.",
      [],
      error
    );
  }
}

export async function getDesiredStateByVersion(
  projectId: string,
  version: number
): Promise<DesiredState | null> {
  try {
    return await getDesiredStateByVersionInPersistence(projectId, version);
  } catch (error) {
    throw new DesiredStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to read the requested Desired State version.",
      [],
      error
    );
  }
}

export async function listDesiredStateVersions(
  projectId: string
): Promise<DesiredState[]> {
  try {
    return await listDesiredStateVersionsInPersistence(projectId);
  } catch (error) {
    throw new DesiredStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to list Desired State versions.",
      [],
      error
    );
  }
}

export interface DesiredStateRetirement {
  projectId: string;
  desiredStateId: string;
  version: number;
  retainedVersions: number;
}

export async function retireDesiredState(
  projectId: string
): Promise<DesiredStateRetirement> {
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new DesiredStateServiceError(
      "VALIDATION_FAILED",
      "projectId must be a non-empty string."
    );
  }
  const current = await getCurrentDesiredStateInPersistence(projectId);
  if (!current) {
    throw new DesiredStateNotFoundError(
      `Project "${projectId}" has no Desired State to retire.`
    );
  }
  const versions = await listDesiredStateVersionsInPersistence(projectId);
  return {
    projectId,
    desiredStateId: current.desiredStateId,
    version: current.version,
    retainedVersions: versions.length,
  };
}

export {
  DesiredStatePersistenceError,
  DuplicateDesiredStateIdError,
  DuplicateVersionError,
  InvalidProjectError,
};
