// Control Plane domain (Work 93).
//
// The Control Plane decides whether execution is needed for a resource's
// desired state and records that decision as an ExecutionJob. Creating a job
// is NOT the same as deploying or remediation — no execution mechanism is
// wired yet; jobs are recorded requests only.

export type ExecutionJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ExecutionJobType =
  | "reconcile"
  | "deploy"
  | "scale"
  | "update"
  | "retire";

export interface ExecutionJobFailure {
  kind: string;
  message: string;
  code?: string;
  occurredAt: Date;
}

// Immutable reference to the Desired State intent a job acts on.
export interface DesiredStateRef {
  desiredStateId: string;
  version: number;
}

export interface ExecutionJob {
  jobId: string;
  projectId: string;
  workloadId: string;
  desiredState: DesiredStateRef;
  jobType: ExecutionJobType;
  status: ExecutionJobStatus;
  // Stable key identifying the (resource, desired-state intent) pair.
  // Repeated create attempts with the same key must not produce duplicates.
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  correlationId?: string;
  failure?: ExecutionJobFailure;
  createdAt: Date;
  updatedAt: Date;
  queuedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

// Draft used when validating a job before persistence assigns ids/timestamps.
export interface ExecutionJobDraft {
  jobId: string;
  projectId: string;
  workloadId: string;
  desiredState: DesiredStateRef;
  jobType: ExecutionJobType;
  status: ExecutionJobStatus;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  correlationId?: string;
  failure?: ExecutionJobFailure;
}

export const EXECUTION_JOB_STATUSES: readonly ExecutionJobStatus[] = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const EXECUTION_JOB_TYPES: readonly ExecutionJobType[] = [
  "reconcile",
  "deploy",
  "scale",
  "update",
  "retire",
] as const;

export const TERMINAL_JOB_STATUSES: readonly ExecutionJobStatus[] = [
  "succeeded",
  "cancelled",
] as const;

export const ACTIVE_JOB_STATUSES: readonly ExecutionJobStatus[] = [
  "pending",
  "queued",
  "running",
] as const;

export function isActiveJobStatus(status: ExecutionJobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

export function isTerminalJobStatus(status: ExecutionJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}
