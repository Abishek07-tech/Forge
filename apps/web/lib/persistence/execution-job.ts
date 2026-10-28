import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../prisma.ts";
import type {
  ExecutionJob,
  ExecutionJobFailure,
  ExecutionJobStatus,
  ExecutionJobType,
} from "../../types/control-plane.ts";
import { lifecycleTimestampsForTransition } from "../control-plane/lifecycle.ts";

export interface ExecutionJobRecordInput {
  jobId: string;
  projectId: string;
  workloadId: string;
  desiredStateId: string;
  desiredStateVersion: number;
  jobType: ExecutionJobType;
  status: ExecutionJobStatus;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  correlationId?: string;
  failure?: ExecutionJobFailure;
  createdAt?: Date;
  updatedAt?: Date;
  queuedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export type ExecutionJobPersistenceErrorCode =
  | "INVALID_PROJECT"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "DUPLICATE_ACTIVE_JOB"
  | "STALE_STATUS_UPDATE";

export class ExecutionJobPersistenceError extends Error {
  readonly code: ExecutionJobPersistenceErrorCode;
  readonly causeError: unknown;

  constructor(
    code: ExecutionJobPersistenceErrorCode,
    message: string,
    causeError?: unknown
  ) {
    super(message);
    this.name = "ExecutionJobPersistenceError";
    this.code = code;
    this.causeError = causeError;
  }
}

export class InvalidProjectError extends ExecutionJobPersistenceError {
  constructor(message: string, causeError?: unknown) {
    super("INVALID_PROJECT", message, causeError);
    this.name = "InvalidProjectError";
  }
}

export class DuplicateIdempotencyKeyError extends ExecutionJobPersistenceError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string, causeError?: unknown) {
    super(
      "DUPLICATE_IDEMPOTENCY_KEY",
      `An execution job with idempotencyKey "${idempotencyKey}" already exists.`,
      causeError
    );
    this.name = "DuplicateIdempotencyKeyError";
    this.idempotencyKey = idempotencyKey;
  }
}

export class DuplicateActiveJobError extends ExecutionJobPersistenceError {
  constructor(message: string, causeError?: unknown) {
    super("DUPLICATE_ACTIVE_JOB", message, causeError);
    this.name = "DuplicateActiveJobError";
  }
}

export class StaleStatusUpdateError extends ExecutionJobPersistenceError {
  readonly jobId: string;
  readonly expectedStatus: ExecutionJobStatus;

  constructor(jobId: string, expectedStatus: ExecutionJobStatus) {
    super(
      "STALE_STATUS_UPDATE",
      `Execution job "${jobId}" is not in status "${expectedStatus}"; the lifecycle update was rejected.`
    );
    this.name = "StaleStatusUpdateError";
    this.jobId = jobId;
    this.expectedStatus = expectedStatus;
  }
}

type PrismaExecutionJob = Prisma.ExecutionJobModel;

function toFailure(
  value: Prisma.JsonValue | null | undefined
): ExecutionJobFailure | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as ExecutionJobFailure).kind !== "string" ||
    typeof (parsed as ExecutionJobFailure).message !== "string"
  ) {
    return undefined;
  }
  const raw = parsed as Record<string, unknown>;
  const failure: ExecutionJobFailure = {
    kind: raw.kind as string,
    message: raw.message as string,
    occurredAt: new Date(String(raw.occurredAt)),
  };
  if (typeof raw.code === "string") {
    failure.code = raw.code;
  }
  return failure;
}

function toDomain(row: PrismaExecutionJob): ExecutionJob {
  const job: ExecutionJob = {
    jobId: row.jobId,
    projectId: row.projectId,
    workloadId: row.workloadId,
    desiredState: {
      desiredStateId: row.desiredStateId,
      version: row.desiredStateVersion,
    },
    jobType: row.jobType as ExecutionJobType,
    status: row.status as ExecutionJobStatus,
    idempotencyKey: row.idempotencyKey,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.correlationId !== null) {
    job.correlationId = row.correlationId;
  }
  const failure = toFailure(row.failure);
  if (failure !== undefined) {
    job.failure = failure;
  }
  if (row.queuedAt !== null) {
    job.queuedAt = row.queuedAt;
  }
  if (row.startedAt !== null) {
    job.startedAt = row.startedAt;
  }
  if (row.finishedAt !== null) {
    job.finishedAt = row.finishedAt;
  }
  return job;
}

const PARTIAL_ACTIVE_INDEX =
  "ExecutionJob_projectId_workloadId_desiredStateId_active_key";

// Prisma 7 + @prisma/adapter-pg surfaces the violated index under
// meta.driverAdapterError.cause.constraint.index (not meta.target).
function extractConstraintIndex(error: {
  meta?: unknown;
}): string | null {
  const meta = error.meta as
    | {
        target?: unknown;
        driverAdapterError?: {
          cause?: { constraint?: { index?: unknown } };
        };
      }
    | undefined;
  if (!meta) {
    return null;
  }
  if (Array.isArray(meta.target)) {
    return meta.target.join(",");
  }
  if (typeof meta.target === "string") {
    return meta.target;
  }
  const index = meta.driverAdapterError?.cause?.constraint?.index;
  if (typeof index === "string") {
    return index;
  }
  return null;
}

function mapPersistenceError(error: unknown, idempotencyKey?: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2003") {
      throw new InvalidProjectError(
        "The referenced project does not exist.",
        error
      );
    }
    if (error.code === "P2002") {
      const target = extractConstraintIndex(error);
      if (target === PARTIAL_ACTIVE_INDEX) {
        throw new DuplicateActiveJobError(
          "An active execution job already exists for this resource and Desired State intent.",
          error
        );
      }
      throw new DuplicateIdempotencyKeyError(
        idempotencyKey ?? "unknown",
        error
      );
    }
  }
  throw error instanceof Error ? error : new Error(String(error));
}

export async function createExecutionJob(
  input: ExecutionJobRecordInput
): Promise<ExecutionJob> {
  try {
    const row = await prisma.executionJob.create({
      data: {
        jobId: input.jobId,
        projectId: input.projectId,
        workloadId: input.workloadId,
        desiredStateId: input.desiredStateId,
        desiredStateVersion: input.desiredStateVersion,
        jobType: input.jobType,
        status: input.status,
        idempotencyKey: input.idempotencyKey,
        attemptCount: input.attemptCount,
        maxAttempts: input.maxAttempts,
        ...(input.correlationId !== undefined
          ? { correlationId: input.correlationId }
          : {}),
        ...(input.failure !== undefined
          ? { failure: input.failure as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
        ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
        ...(input.queuedAt !== undefined ? { queuedAt: input.queuedAt } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.finishedAt !== undefined
          ? { finishedAt: input.finishedAt }
          : {}),
      },
    });
    return toDomain(row);
  } catch (error) {
    mapPersistenceError(error, input.idempotencyKey);
  }
}

export async function getExecutionJobById(
  jobId: string
): Promise<ExecutionJob | null> {
  const row = await prisma.executionJob.findUnique({ where: { jobId } });
  return row ? toDomain(row) : null;
}

export async function getExecutionJobByIdempotencyKey(
  idempotencyKey: string
): Promise<ExecutionJob | null> {
  const row = await prisma.executionJob.findUnique({
    where: { idempotencyKey },
  });
  return row ? toDomain(row) : null;
}

export async function findActiveJobForIntent(
  projectId: string,
  workloadId: string,
  desiredStateId: string
): Promise<ExecutionJob | null> {
  const row = await prisma.executionJob.findFirst({
    where: {
      projectId,
      workloadId,
      desiredStateId,
      status: { in: ["pending", "queued", "running"] },
    },
    orderBy: { createdAt: "desc" },
  });
  return row ? toDomain(row) : null;
}

export interface ListExecutionJobsFilter {
  projectId: string;
  workloadId?: string;
  status?: ExecutionJobStatus;
  jobType?: ExecutionJobType;
  limit?: number;
  offset?: number;
}

export interface ListExecutionJobsResult {
  jobs: ExecutionJob[];
  total: number;
  limit: number;
  offset: number;
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export async function listExecutionJobs(
  filter: ListExecutionJobsFilter
): Promise<ListExecutionJobsResult> {
  const where: Prisma.ExecutionJobWhereInput = { projectId: filter.projectId };
  if (filter.workloadId !== undefined) {
    where.workloadId = filter.workloadId;
  }
  if (filter.status !== undefined) {
    where.status = filter.status;
  }
  if (filter.jobType !== undefined) {
    where.jobType = filter.jobType;
  }

  const limit = Math.min(
    Math.max(filter.limit ?? DEFAULT_LIST_LIMIT, 1),
    MAX_LIST_LIMIT
  );
  const offset = Math.max(filter.offset ?? 0, 0);

  const [rows, total] = await Promise.all([
    prisma.executionJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { jobId: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.executionJob.count({ where }),
  ]);

  return {
    jobs: rows.map(toDomain),
    total,
    limit,
    offset,
  };
}

export interface StatusUpdateInput {
  jobId: string;
  expectedStatus: ExecutionJobStatus;
  nextStatus: ExecutionJobStatus;
  now: Date;
  failure?: ExecutionJobFailure;
  incrementAttempt?: boolean;
}

// Optimistic concurrency: the UPDATE only applies when the row still has
// `expectedStatus`. Zero affected rows means a concurrent writer won.
export async function updateExecutionJobStatus(
  input: StatusUpdateInput
): Promise<ExecutionJob> {
  const timestamps = lifecycleTimestampsForTransition(input.nextStatus, input.now);

  const data: Prisma.ExecutionJobUpdateManyMutationInput = {
    status: input.nextStatus,
    updatedAt: input.now,
  };
  if (timestamps.queuedAt !== undefined) {
    data.queuedAt = timestamps.queuedAt;
  }
  if (timestamps.startedAt !== undefined) {
    data.startedAt = timestamps.startedAt;
  }
  if (timestamps.finishedAt !== undefined) {
    data.finishedAt = timestamps.finishedAt;
  }
  if (input.incrementAttempt === true) {
    data.attemptCount = { increment: 1 };
  }
  if (input.failure !== undefined) {
    data.failure = input.failure as unknown as Prisma.InputJsonValue;
  }

  const result = await prisma.executionJob.updateMany({
    where: { jobId: input.jobId, status: input.expectedStatus },
    data,
  });

  if (result.count === 0) {
    const existing = await prisma.executionJob.findUnique({
      where: { jobId: input.jobId },
    });
    if (!existing) {
      throw new StaleStatusUpdateError(input.jobId, input.expectedStatus);
    }
    throw new StaleStatusUpdateError(input.jobId, input.expectedStatus);
  }

  const row = await prisma.executionJob.findUnique({
    where: { jobId: input.jobId },
  });
  if (!row) {
    throw new StaleStatusUpdateError(input.jobId, input.expectedStatus);
  }
  return toDomain(row);
}

export async function deleteExecutionJobsForProject(
  projectId: string
): Promise<void> {
  await prisma.executionJob.deleteMany({ where: { projectId } });
}
