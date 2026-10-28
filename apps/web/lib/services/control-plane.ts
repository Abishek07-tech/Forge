import { randomUUID } from "node:crypto";
import type { DesiredState } from "../../types/desired-state.ts";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type {
  ExecutionJob,
  ExecutionJobFailure,
} from "../../types/control-plane.ts";
import { isActiveJobStatus } from "../../types/control-plane.ts";
import type { DriftComparisonResult } from "../../types/drift.ts";
import { compareDesiredAndActual } from "../drift/comparison.ts";
import { getCurrentDesiredState } from "./desired-state.ts";
import { getLatestObservation } from "./actual-state.ts";
import {
  createExecutionJob,
  findActiveJobForIntent,
  getExecutionJobById,
  getExecutionJobByIdempotencyKey,
  updateExecutionJobStatus,
  listExecutionJobs,
  MAX_LIST_LIMIT,
  DuplicateActiveJobError,
  DuplicateIdempotencyKeyError,
  InvalidProjectError,
  StaleStatusUpdateError,
  type ExecutionJobRecordInput,
  type ListExecutionJobsResult,
} from "../persistence/execution-job.ts";
import { projectExists } from "../persistence/project.ts";
import { assertValidJobTransition } from "../control-plane/lifecycle.ts";
import { defaultLogger, type Logger } from "../observability/logger.ts";

export const DEFAULT_OBSERVATION_STALE_AFTER_MS = 5 * 60 * 1000;

export type ControlPlaneServiceErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "PERSISTENCE_FAILED";

export class ControlPlaneServiceError extends Error {
  readonly code: ControlPlaneServiceErrorCode;
  readonly causeError: unknown;

  constructor(
    code: ControlPlaneServiceErrorCode,
    message: string,
    causeError?: unknown
  ) {
    super(message);
    this.name = "ControlPlaneServiceError";
    this.code = code;
    this.causeError = causeError;
  }
}

export class ControlPlaneNotFoundError extends ControlPlaneServiceError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "ControlPlaneNotFoundError";
  }
}

export class ControlPlaneConflictError extends ControlPlaneServiceError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ControlPlaneConflictError";
  }
}

export class InvalidJobTransitionServiceError extends ControlPlaneServiceError {
  constructor(message: string) {
    super("INVALID_TRANSITION", message);
    this.name = "InvalidJobTransitionServiceError";
  }
}

function ensureNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlPlaneServiceError(
      "VALIDATION_FAILED",
      `${field} must be a non-empty string.`
    );
  }
}

// Deterministic key for a (resource, desired-state intent) pair so repeated
// evaluations for the same intent collapse to one logical request.
export function deriveIdempotencyKey(
  jobType: string,
  projectId: string,
  workloadId: string,
  desiredStateId: string
): string {
  return `${jobType}:${projectId}:${workloadId}:${desiredStateId}`;
}

export type EvaluationOutcome =
  | {
      outcome: "desired-state-unavailable";
      projectId: string;
      workloadId: string;
      reason: string;
    }
  | {
      outcome: "observation-unavailable";
      projectId: string;
      workloadId: string;
      desiredState: { desiredStateId: string; version: number };
      reason: string;
    }
  | {
      outcome: "observation-stale";
      projectId: string;
      workloadId: string;
      desiredState: { desiredStateId: string; version: number };
      observation: { observationId: string; observedAt: Date };
      ageMs: number;
      staleAfterMs: number;
      reason: string;
    }
  | {
      outcome: "evaluation-failed";
      projectId: string;
      workloadId: string;
      reason: string;
    }
  | {
      outcome: "no-action";
      projectId: string;
      workloadId: string;
      desiredState: { desiredStateId: string; version: number };
      observation: { observationId: string; observedAt: Date };
      comparison: DriftComparisonResult;
      reason: string;
    }
  | {
      outcome: "execution-requested";
      projectId: string;
      workloadId: string;
      desiredState: { desiredStateId: string; version: number };
      observation: { observationId: string; observedAt: Date };
      comparison: DriftComparisonResult;
      job: ExecutionJob;
      reason: string;
    }
  | {
      outcome: "already-active";
      projectId: string;
      workloadId: string;
      desiredState: { desiredStateId: string; version: number };
      observation: { observationId: string; observedAt: Date };
      comparison: DriftComparisonResult;
      job: ExecutionJob;
      reason: string;
    }
  | {
      // Client-supplied idempotency key replayed onto a terminal job.
      outcome: "already-recorded";
      projectId: string;
      workloadId: string;
      desiredState: { desiredStateId: string; version: number };
      observation: { observationId: string; observedAt: Date };
      comparison: DriftComparisonResult;
      job: ExecutionJob;
      reason: string;
    };

export interface EvaluateResourceOptions {
  workloadId?: string;
  jobType?: "reconcile";
  idempotencyKey?: string;
  correlationId?: string;
  now?: Date;
  staleAfterMs?: number;
  maxAttempts?: number;
  logger?: Logger;
}

function summarizeDesired(desired: DesiredState) {
  return { desiredStateId: desired.desiredStateId, version: desired.version };
}

function summarizeObservation(observation: ActualStateObservation) {
  return {
    observationId: observation.observationId,
    observedAt: observation.observedAt,
  };
}

async function persistJob(
  input: ExecutionJobRecordInput,
  logger: Logger
): Promise<ExecutionJob> {
  try {
    return await createExecutionJob(input);
  } catch (error) {
    if (error instanceof DuplicateIdempotencyKeyError) {
      const existing = await getExecutionJobByIdempotencyKey(
        input.idempotencyKey
      );
      if (existing) {
        logger.info("control-plane.job.idempotent-replay", {
          jobId: existing.jobId,
          idempotencyKey: input.idempotencyKey,
        });
        return existing;
      }
      throw new ControlPlaneConflictError(error.message);
    }
    if (error instanceof DuplicateActiveJobError) {
      const active = await findActiveJobForIntent(
        input.projectId,
        input.workloadId,
        input.desiredStateId
      );
      if (active) {
        logger.info("control-plane.job.active-exists", {
          jobId: active.jobId,
          projectId: input.projectId,
          workloadId: input.workloadId,
          desiredStateId: input.desiredStateId,
        });
        return active;
      }
      throw new ControlPlaneConflictError(error.message);
    }
    if (error instanceof InvalidProjectError) {
      throw new ControlPlaneNotFoundError(
        "The referenced project does not exist."
      );
    }
    throw new ControlPlaneServiceError(
      "PERSISTENCE_FAILED",
      "Failed to persist the execution job.",
      error
    );
  }
}

// Evaluate Desired vs Actual State for a resource and, when drift requires it,
// record an execution request (ExecutionJob). Creating a job does NOT deploy,
// remediate, or reconcile anything — it only records the request.
export async function evaluateResourceAndRequestExecution(
  projectId: string,
  options: EvaluateResourceOptions = {}
): Promise<EvaluationOutcome> {
  ensureNonEmpty(projectId, "projectId");
  const workloadId = options.workloadId ?? "default";
  ensureNonEmpty(workloadId, "workloadId");
  if (
    options.idempotencyKey !== undefined &&
    options.idempotencyKey.trim() === ""
  ) {
    throw new ControlPlaneServiceError(
      "VALIDATION_FAILED",
      "idempotencyKey must be a non-empty string when provided."
    );
  }
  const jobType = options.jobType ?? "reconcile";
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_OBSERVATION_STALE_AFTER_MS;
  const maxAttempts = options.maxAttempts ?? 3;

  const logger = (options.logger ?? defaultLogger).child({
    component: "control-plane",
    projectId,
    workloadId,
  });

  // Unknown projects are a missing resource, not "no desired state".
  let projectFound: boolean;
  try {
    projectFound = await projectExists(projectId);
  } catch (error) {
    throw new ControlPlaneServiceError(
      "PERSISTENCE_FAILED",
      "Failed to verify the project exists.",
      error
    );
  }
  if (!projectFound) {
    throw new ControlPlaneNotFoundError(
      `Project "${projectId}" does not exist.`
    );
  }

  let desired: DesiredState | null;
  try {
    desired = await getCurrentDesiredState(projectId);
  } catch (error) {
    logger.error("control-plane.evaluation.desired-state-read-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ControlPlaneServiceError(
      "PERSISTENCE_FAILED",
      "Failed to read the current Desired State.",
      error
    );
  }

  if (!desired) {
    logger.warn("control-plane.evaluation.desired-state-unavailable", {});
    return {
      outcome: "desired-state-unavailable",
      projectId,
      workloadId,
      reason: "No Desired State exists for this project.",
    };
  }

  let observation: ActualStateObservation | null;
  try {
    observation = await getLatestObservation(projectId, workloadId);
  } catch (error) {
    logger.error("control-plane.evaluation.observation-read-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ControlPlaneServiceError(
      "PERSISTENCE_FAILED",
      "Failed to read the latest Actual State observation.",
      error
    );
  }

  if (!observation) {
    logger.warn("control-plane.evaluation.observation-unavailable", {
      desiredStateId: desired.desiredStateId,
    });
    return {
      outcome: "observation-unavailable",
      projectId,
      workloadId,
      desiredState: summarizeDesired(desired),
      reason:
        "No Actual State observation exists for this resource; execution is not requested without observed state.",
    };
  }

  const ageMs = now.getTime() - observation.observedAt.getTime();
  if (ageMs > staleAfterMs) {
    logger.warn("control-plane.evaluation.observation-stale", {
      ageMs,
      staleAfterMs,
      observationId: observation.observationId,
    });
    return {
      outcome: "observation-stale",
      projectId,
      workloadId,
      desiredState: summarizeDesired(desired),
      observation: summarizeObservation(observation),
      ageMs,
      staleAfterMs,
      reason:
        "The latest Actual State observation is stale; execution is not requested from stale observations.",
    };
  }

  let comparison: DriftComparisonResult;
  try {
    comparison = compareDesiredAndActual(desired, observation);
  } catch (error) {
    logger.error("control-plane.evaluation.comparison-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      outcome: "evaluation-failed",
      projectId,
      workloadId,
      reason:
        error instanceof Error
          ? error.message
          : "Desired/Actual State comparison failed.",
    };
  }

  if (comparison.outcome === "match") {
    logger.info("control-plane.evaluation.no-action", {
      desiredStateId: desired.desiredStateId,
      observationId: observation.observationId,
    });
    return {
      outcome: "no-action",
      projectId,
      workloadId,
      desiredState: summarizeDesired(desired),
      observation: summarizeObservation(observation),
      comparison,
      reason: "Actual State matches Desired State; no execution requested.",
    };
  }

  if (comparison.outcome === "insufficient-data") {
    return {
      outcome: "evaluation-failed",
      projectId,
      workloadId,
      reason:
        "Comparison produced insufficient data; execution is not requested.",
    };
  }

  // Drift detected → record an execution request.
  //
  // Idempotency semantics:
  // - An ACTIVE job for the same (resource, desired-state intent) always wins:
  //   no redundant job is created and the active job is returned.
  // - A client-supplied idempotency key is a strict replay contract: the same
  //   key always resolves to the same recorded job, whatever its status.
  // - The deterministic derived key identifies the intent; when it maps to a
  //   TERMINAL job (e.g. cancelled/failed), a new request is legitimate and
  //   gets a fresh unique key derived from the same intent.
  const clientKey = options.idempotencyKey;
  const derivedKey = deriveIdempotencyKey(
    jobType,
    projectId,
    workloadId,
    desired.desiredStateId
  );

  // If an equivalent active job already exists for this intent, do not create
  // a redundant one.
  const active = await findActiveJobForIntent(
    projectId,
    workloadId,
    desired.desiredStateId
  );
  if (active) {
    logger.info("control-plane.evaluation.already-active", {
      jobId: active.jobId,
      idempotencyKey: active.idempotencyKey,
    });
    return {
      outcome: "already-active",
      projectId,
      workloadId,
      desiredState: summarizeDesired(desired),
      observation: summarizeObservation(observation),
      comparison,
      job: active,
      reason:
        "An active execution job already exists for this resource and Desired State intent.",
    };
  }

  let idempotencyKey = clientKey ?? derivedKey;
  if (!clientKey) {
    const existingForKey = await getExecutionJobByIdempotencyKey(derivedKey);
    if (existingForKey) {
      // The derived key maps to a terminal job → this is a new request for
      // the same intent (e.g. the previous job was cancelled or failed).
      idempotencyKey = `${derivedKey}#${randomUUID()}`;
      logger.info("control-plane.evaluation.new-request-after-terminal", {
        previousJobId: existingForKey.jobId,
        previousStatus: existingForKey.status,
      });
    }
  } else {
    const existingForKey = await getExecutionJobByIdempotencyKey(clientKey);
    if (existingForKey) {
      // Strict replay: the same client key resolves to the same job.
      const replayActive = isActiveJobStatus(existingForKey.status);
      logger.info("control-plane.evaluation.idempotent-replay", {
        jobId: existingForKey.jobId,
        status: existingForKey.status,
      });
      return {
        outcome: replayActive ? "already-active" : "already-recorded",
        projectId,
        workloadId,
        desiredState: summarizeDesired(desired),
        observation: summarizeObservation(observation),
        comparison,
        job: existingForKey,
        reason: `Idempotency key "${clientKey}" already maps to job "${existingForKey.jobId}" (status: ${existingForKey.status}); no new job created.`,
      };
    }
  }

  const jobInput: ExecutionJobRecordInput = {
    jobId: randomUUID(),
    projectId,
    workloadId,
    desiredStateId: desired.desiredStateId,
    desiredStateVersion: desired.version,
    jobType,
    status: "pending",
    idempotencyKey,
    attemptCount: 0,
    maxAttempts,
    createdAt: now,
    updatedAt: now,
    ...(options.correlationId !== undefined
      ? { correlationId: options.correlationId }
      : {}),
  };

  const job = await persistJob(jobInput, logger);
  const created = job.jobId === jobInput.jobId;

  logger.info(
    created
      ? "control-plane.evaluation.execution-requested"
      : "control-plane.evaluation.job-reused",
    {
      jobId: job.jobId,
      desiredStateId: desired.desiredStateId,
      desiredStateVersion: desired.version,
      idempotencyKey,
    }
  );

  return {
    outcome: created ? "execution-requested" : "already-active",
    projectId,
    workloadId,
    desiredState: summarizeDesired(desired),
    observation: summarizeObservation(observation),
    comparison,
    job,
    reason: created
      ? "Drift detected; an execution request was recorded."
      : "Drift detected; an existing execution job was reused.",
  };
}

export interface ListJobsFilter {
  workloadId?: string;
  status?: string;
  jobType?: string;
  limit?: string;
  offset?: string;
}

const STATUS_VALUES = new Set([
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const JOB_TYPE_VALUES = new Set([
  "reconcile",
  "deploy",
  "scale",
  "update",
  "retire",
]);

function parseOptionalPositiveInt(
  raw: string | undefined,
  field: string,
  min: number,
  max: number
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ControlPlaneServiceError(
      "VALIDATION_FAILED",
      `${field} must be an integer between ${min} and ${max}.`
    );
  }
  return value;
}

// Validated job listing for the API layer. Filter/pagination errors surface as
// VALIDATION_FAILED; persistence failures surface as PERSISTENCE_FAILED.
export async function listJobs(
  projectId: string,
  filter: ListJobsFilter = {}
): Promise<ListExecutionJobsResult> {
  ensureNonEmpty(projectId, "projectId");

  let found = false;
  try {
    found = await projectExists(projectId);
  } catch (error) {
    throw new ControlPlaneServiceError(
      "PERSISTENCE_FAILED",
      "Failed to verify the project exists.",
      error
    );
  }
  if (!found) {
    throw new ControlPlaneNotFoundError(
      `Project "${projectId}" does not exist.`
    );
  }

  if (filter.status !== undefined && !STATUS_VALUES.has(filter.status)) {
    throw new ControlPlaneServiceError(
      "VALIDATION_FAILED",
      `status must be one of: ${[...STATUS_VALUES].join(", ")}.`
    );
  }
  if (filter.jobType !== undefined && !JOB_TYPE_VALUES.has(filter.jobType)) {
    throw new ControlPlaneServiceError(
      "VALIDATION_FAILED",
      `jobType must be one of: ${[...JOB_TYPE_VALUES].join(", ")}.`
    );
  }

  const limit = parseOptionalPositiveInt(
    filter.limit,
    "limit",
    1,
    MAX_LIST_LIMIT
  );
  const offset = parseOptionalPositiveInt(filter.offset, "offset", 0, 1_000_000);

  try {
    return await listExecutionJobs({
      projectId,
      ...(filter.workloadId !== undefined ? { workloadId: filter.workloadId } : {}),
      ...(filter.status !== undefined
        ? { status: filter.status as Parameters<typeof listExecutionJobs>[0]["status"] }
        : {}),
      ...(filter.jobType !== undefined
        ? { jobType: filter.jobType as Parameters<typeof listExecutionJobs>[0]["jobType"] }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    });
  } catch (error) {
    throw new ControlPlaneServiceError(
      "PERSISTENCE_FAILED",
      "Failed to list execution jobs.",
      error
    );
  }
}

export async function getExecutionJob(
  jobId: string
): Promise<ExecutionJob> {
  ensureNonEmpty(jobId, "jobId");
  const job = await getExecutionJobById(jobId);
  if (!job) {
    throw new ControlPlaneNotFoundError(
      `Execution job "${jobId}" does not exist.`
    );
  }
  return job;
}

export interface AdvanceJobOptions {
  now?: Date;
  failure?: ExecutionJobFailure;
  incrementAttempt?: boolean;
}

// Advance a job through its lifecycle. Invalid transitions are rejected both
// by the pure transition rules and by the optimistic status guard in
// persistence.
export async function advanceExecutionJob(
  jobId: string,
  from: ExecutionJob["status"],
  to: ExecutionJob["status"],
  options: AdvanceJobOptions = {}
): Promise<ExecutionJob> {
  ensureNonEmpty(jobId, "jobId");
  const now = options.now ?? new Date();

  try {
    assertValidJobTransition(from, to);
  } catch (error) {
    throw new InvalidJobTransitionServiceError(
      error instanceof Error ? error.message : "Invalid job transition."
    );
  }

  try {
    return await updateExecutionJobStatus({
      jobId,
      expectedStatus: from,
      nextStatus: to,
      now,
      ...(options.failure !== undefined ? { failure: options.failure } : {}),
      ...(options.incrementAttempt !== undefined
        ? { incrementAttempt: options.incrementAttempt }
        : {}),
    });
  } catch (error) {
    if (error instanceof StaleStatusUpdateError) {
      throw new ControlPlaneConflictError(
        `Execution job "${jobId}" is no longer in status "${from}".`
      );
    }
    if (
      error instanceof InvalidProjectError ||
      (error as { name?: string })?.name === "InvalidProjectError"
    ) {
      throw new ControlPlaneNotFoundError(
        "The referenced project does not exist."
      );
    }
    throw new ControlPlaneServiceError(
      "PERSISTENCE_FAILED",
      "Failed to update the execution job lifecycle.",
      error
    );
  }
}
