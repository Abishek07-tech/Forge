import {
  EXECUTION_JOB_STATUSES,
  EXECUTION_JOB_TYPES,
  type ExecutionJobDraft,
  type ExecutionJobFailure,
  type ExecutionJobStatus,
  type ExecutionJobType,
} from "../../types/control-plane.ts";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ExecutionJobValidationResult {
  valid: boolean;
  errors: ValidationError[];
  job?: ExecutionJobDraft;
}

const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  body: Record<string, unknown>,
  key: string,
  errors: ValidationError[]
): string | null {
  const value = body[key];
  if (value === undefined) {
    errors.push({ path: key, message: `${key} is required` });
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path: key, message: `${key} must be a non-empty string` });
    return null;
  }
  return value;
}

function validateFailure(
  value: unknown,
  path: string,
  errors: ValidationError[]
): ExecutionJobFailure | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    errors.push({ path, message: `${path} must be an object when present` });
    return undefined;
  }
  const kind = value.kind;
  const message = value.message;
  const occurredAt = value.occurredAt;
  let ok = true;
  if (typeof kind !== "string" || kind.trim() === "") {
    errors.push({ path: `${path}.kind`, message: "kind must be a non-empty string" });
    ok = false;
  }
  if (typeof message !== "string" || message.trim() === "") {
    errors.push({
      path: `${path}.message`,
      message: "message must be a non-empty string",
    });
    ok = false;
  }
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
    errors.push({
      path: `${path}.occurredAt`,
      message: "occurredAt must be a valid Date",
    });
    ok = false;
  }
  if (!ok) {
    return undefined;
  }
  const failure: ExecutionJobFailure = {
    kind: kind as string,
    message: message as string,
    occurredAt: occurredAt as Date,
  };
  if (typeof value.code === "string") {
    failure.code = value.code;
  }
  return failure;
}

export function validateExecutionJobDraft(
  input: unknown
): ExecutionJobValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    errors.push({ path: "job", message: "Execution job must be an object" });
    return { valid: false, errors };
  }

  const body = input as Record<string, unknown>;

  const jobId = requireNonEmptyString(body, "jobId", errors);
  const projectId = requireNonEmptyString(body, "projectId", errors);
  const workloadId = requireNonEmptyString(body, "workloadId", errors);
  const idempotencyKey = requireNonEmptyString(body, "idempotencyKey", errors);

  let desiredState: ExecutionJobDraft["desiredState"] | undefined;
  if (body.desiredState === undefined) {
    errors.push({ path: "desiredState", message: "desiredState is required" });
  } else if (!isPlainObject(body.desiredState)) {
    errors.push({
      path: "desiredState",
      message: "desiredState must be an object",
    });
  } else {
    const ds = body.desiredState as Record<string, unknown>;
    let desiredStateId: string | null = null;
    if (ds.desiredStateId === undefined) {
      errors.push({
        path: "desiredState.desiredStateId",
        message: "desiredState.desiredStateId is required",
      });
    } else if (
      typeof ds.desiredStateId !== "string" ||
      ds.desiredStateId.trim() === ""
    ) {
      errors.push({
        path: "desiredState.desiredStateId",
        message: "desiredState.desiredStateId must be a non-empty string",
      });
    } else {
      desiredStateId = ds.desiredStateId;
    }
    const version = ds.version;
    let versionOk = true;
    if (version === undefined) {
      errors.push({
        path: "desiredState.version",
        message: "desiredState.version is required",
      });
      versionOk = false;
    } else if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      errors.push({
        path: "desiredState.version",
        message: "desiredState.version must be a positive integer",
      });
      versionOk = false;
    }
    if (desiredStateId && versionOk) {
      desiredState = {
        desiredStateId,
        version: version as number,
      };
    }
  }

  let jobType: ExecutionJobType | undefined;
  if (body.jobType === undefined) {
    errors.push({ path: "jobType", message: "jobType is required" });
  } else if (
    typeof body.jobType !== "string" ||
    !(EXECUTION_JOB_TYPES as readonly string[]).includes(body.jobType)
  ) {
    errors.push({
      path: "jobType",
      message: `jobType must be one of: ${EXECUTION_JOB_TYPES.join(", ")}`,
    });
  } else {
    jobType = body.jobType as ExecutionJobType;
  }

  let status: ExecutionJobStatus | undefined;
  if (body.status === undefined) {
    errors.push({ path: "status", message: "status is required" });
  } else if (
    typeof body.status !== "string" ||
    !(EXECUTION_JOB_STATUSES as readonly string[]).includes(body.status)
  ) {
    errors.push({
      path: "status",
      message: `status must be one of: ${EXECUTION_JOB_STATUSES.join(", ")}`,
    });
  } else {
    status = body.status as ExecutionJobStatus;
  }

  let attemptCount = 0;
  if (body.attemptCount === undefined) {
    errors.push({ path: "attemptCount", message: "attemptCount is required" });
  } else if (
    typeof body.attemptCount !== "number" ||
    !Number.isInteger(body.attemptCount) ||
    body.attemptCount < 0
  ) {
    errors.push({
      path: "attemptCount",
      message: "attemptCount must be a non-negative integer",
    });
  } else {
    attemptCount = body.attemptCount;
  }

  let maxAttempts = 3;
  if (body.maxAttempts === undefined) {
    errors.push({ path: "maxAttempts", message: "maxAttempts is required" });
  } else if (
    typeof body.maxAttempts !== "number" ||
    !Number.isInteger(body.maxAttempts) ||
    body.maxAttempts < MIN_MAX_ATTEMPTS ||
    body.maxAttempts > MAX_MAX_ATTEMPTS
  ) {
    errors.push({
      path: "maxAttempts",
      message: `maxAttempts must be an integer between ${MIN_MAX_ATTEMPTS} and ${MAX_MAX_ATTEMPTS}`,
    });
  } else {
    maxAttempts = body.maxAttempts;
  }

  let correlationId: string | undefined;
  if (body.correlationId !== undefined) {
    if (typeof body.correlationId !== "string" || body.correlationId.trim() === "") {
      errors.push({
        path: "correlationId",
        message: "correlationId must be a non-empty string when present",
      });
    } else {
      correlationId = body.correlationId;
    }
  }

  const failure = validateFailure(body.failure, "failure", errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const job: ExecutionJobDraft = {
    jobId: jobId as string,
    projectId: projectId as string,
    workloadId: workloadId as string,
    desiredState: desiredState as ExecutionJobDraft["desiredState"],
    jobType: jobType as ExecutionJobType,
    status: status as ExecutionJobStatus,
    idempotencyKey: idempotencyKey as string,
    attemptCount,
    maxAttempts,
  };
  if (correlationId !== undefined) {
    job.correlationId = correlationId;
  }
  if (failure !== undefined) {
    job.failure = failure;
  }

  return { valid: true, errors: [], job };
}
