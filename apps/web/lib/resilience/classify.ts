export type FailureDisposition = "retryable" | "permanent" | "invalid";

export interface ClassifiedFailure {
  disposition: FailureDisposition;
  errorName: string;
  message: string;
  code: string | null;
  cause: unknown;
}

const INVALID_NAMES = new Set([
  "ActualStateValidationFailedError",
  "RuntimeStatusServiceError",
  "HealthCheckValidationError",
  "DesiredStateValidationFailedError",
  "DriftServiceError",
]);

const PERMANENT_NAMES = new Set([
  "ActualStateConflictError",
  "DuplicateObservationError",
  "InvalidProjectError",
  "DriftComparisonError",
]);

const RETRYABLE_CODES = new Set([
  "PERSISTENCE_FAILED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ABORT_ERR",
]);

const PERMANENT_CODES = new Set([
  "CONFLICT",
  "INVALID_PROJECT",
  "DUPLICATE_OBSERVATION",
  "P2002",
  "P2003",
]);

const INVALID_CODES = new Set(["VALIDATION_FAILED"]);

function extractCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
  }
  return null;
}

export function classifyFailure(error: unknown): ClassifiedFailure {
  const errorName = error instanceof Error ? error.name : "NonError";
  const message = error instanceof Error ? error.message : String(error);
  const code = extractCode(error);

  if (INVALID_NAMES.has(errorName)) {
    return { disposition: "invalid", errorName, message, code, cause: error };
  }
  if (PERMANENT_NAMES.has(errorName)) {
    return { disposition: "permanent", errorName, message, code, cause: error };
  }
  if (code !== null && INVALID_CODES.has(code)) {
    return { disposition: "invalid", errorName, message, code, cause: error };
  }
  if (code !== null && PERMANENT_CODES.has(code)) {
    return { disposition: "permanent", errorName, message, code, cause: error };
  }
  if (errorName === "TimeoutError" || errorName === "AbortError") {
    return { disposition: "retryable", errorName, message, code, cause: error };
  }
  if (code !== null && RETRYABLE_CODES.has(code)) {
    return { disposition: "retryable", errorName, message, code, cause: error };
  }
  if (
    /fetch failed|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(
      message
    )
  ) {
    return { disposition: "retryable", errorName, message, code, cause: error };
  }
  return { disposition: "retryable", errorName, message, code, cause: error };
}
