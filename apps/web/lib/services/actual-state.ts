import type { ActualStateObservation } from "../../types/actual-state.ts";
import {
  validateActualStateObservation,
  type ValidationError,
} from "../validation/actual-state.ts";
import {
  createObservation as createObservationInPersistence,
  getLatestObservation as getLatestObservationInPersistence,
  listObservations as listObservationsInPersistence,
  ActualStatePersistenceError,
  InvalidProjectError,
} from "../persistence/actual-state.ts";

export type ActualStateServiceErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "PERSISTENCE_FAILED";

export class ActualStateServiceError extends Error {
  readonly code: ActualStateServiceErrorCode;
  readonly errors: ValidationError[];
  readonly causeError: unknown;

  constructor(
    code: ActualStateServiceErrorCode,
    message: string,
    errors: ValidationError[] = [],
    causeError?: unknown
  ) {
    super(message);
    this.name = "ActualStateServiceError";
    this.code = code;
    this.errors = errors;
    this.causeError = causeError;
  }
}

export class ActualStateValidationFailedError extends ActualStateServiceError {
  readonly validationErrors: ValidationError[];

  constructor(validationErrors: ValidationError[]) {
    super(
      "VALIDATION_FAILED",
      "Actual State observation failed validation.",
      validationErrors
    );
    this.name = "ActualStateValidationFailedError";
    this.validationErrors = validationErrors;
  }
}

export class ActualStateNotFoundError extends ActualStateServiceError {
  constructor(
    message = "The requested Actual State observation does not exist."
  ) {
    super("NOT_FOUND", message);
    this.name = "ActualStateNotFoundError";
  }
}

export function ensureValidActualStateObservation(
  input: unknown
): asserts input is ActualStateObservation {
  const result = validateActualStateObservation(input);
  if (!result.valid) {
    throw new ActualStateValidationFailedError(result.errors);
  }
}

export async function recordObservation(
  input: ActualStateObservation
): Promise<ActualStateObservation> {
  ensureValidActualStateObservation(input);
  try {
    return await createObservationInPersistence(input);
  } catch (error) {
    if (error instanceof ActualStatePersistenceError) {
      throw error;
    }
    throw new ActualStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to persist the Actual State observation.",
      [],
      error
    );
  }
}

export async function getLatestObservation(
  projectId: string,
  workloadId: string
): Promise<ActualStateObservation | null> {
  try {
    return await getLatestObservationInPersistence(projectId, workloadId);
  } catch (error) {
    throw new ActualStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to read the latest Actual State observation.",
      [],
      error
    );
  }
}

export async function listObservations(
  projectId: string,
  workloadId: string
): Promise<ActualStateObservation[]> {
  try {
    return await listObservationsInPersistence(projectId, workloadId);
  } catch (error) {
    throw new ActualStateServiceError(
      "PERSISTENCE_FAILED",
      "Failed to list Actual State observations.",
      [],
      error
    );
  }
}

export { ActualStatePersistenceError, InvalidProjectError };
