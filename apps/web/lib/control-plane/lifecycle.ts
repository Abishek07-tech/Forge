import {
  EXECUTION_JOB_STATUSES,
  type ExecutionJobStatus,
} from "../../types/control-plane.ts";

// Valid lifecycle transitions for an execution job (Work 93).
//
// pending   → queued, failed, cancelled
// queued    → running, failed, cancelled
// running   → succeeded, failed, cancelled
// failed    → queued (bounded re-queue), cancelled
// succeeded → (terminal)
// cancelled → (terminal)
//
// Terminal statuses are absorbing: no transitions out of them.

const ALLOWED_TRANSITIONS: Readonly<
  Record<ExecutionJobStatus, readonly ExecutionJobStatus[]>
> = {
  pending: ["queued", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  failed: ["queued", "cancelled"],
  succeeded: [],
  cancelled: [],
};

export class InvalidJobTransitionError extends Error {
  readonly from: ExecutionJobStatus;
  readonly to: ExecutionJobStatus;

  constructor(from: ExecutionJobStatus, to: ExecutionJobStatus) {
    super(`Invalid execution job transition: ${from} → ${to}.`);
    this.name = "InvalidJobTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isExecutionJobStatus(value: unknown): value is ExecutionJobStatus {
  return (
    typeof value === "string" &&
    (EXECUTION_JOB_STATUSES as readonly string[]).includes(value)
  );
}

export function canTransitionJobStatus(
  from: ExecutionJobStatus,
  to: ExecutionJobStatus
): boolean {
  if (!isExecutionJobStatus(from) || !isExecutionJobStatus(to)) {
    return false;
  }
  if (from === to) {
    return false;
  }
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedTransitionsFrom(
  from: ExecutionJobStatus
): readonly ExecutionJobStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

export function assertValidJobTransition(
  from: ExecutionJobStatus,
  to: ExecutionJobStatus
): void {
  if (!canTransitionJobStatus(from, to)) {
    throw new InvalidJobTransitionError(from, to);
  }
}

export interface LifecycleTimestamps {
  queuedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

// Timestamp fields that should be stamped (once) when entering `to`.
export function lifecycleTimestampsForTransition(
  to: ExecutionJobStatus,
  now: Date
): LifecycleTimestamps {
  switch (to) {
    case "queued":
      return { queuedAt: now };
    case "running":
      return { startedAt: now };
    case "succeeded":
    case "failed":
    case "cancelled":
      return { finishedAt: now };
    case "pending":
      return {};
  }
}
