import type {
  ObservedHealthStatus,
  ObservedStatus,
} from "../../types/actual-state.ts";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type {
  RuntimeStatusReport,
  RuntimeStatusView,
} from "../../types/runtime-status.ts";
import { toRuntimeStatusSnapshot } from "../../types/runtime-status.ts";
import { validateRuntimeStatusReport } from "../validation/runtime-status.ts";
import type { ValidationError } from "../validation/actual-state.ts";
import { defaultLogger, type Logger } from "../observability/logger.ts";
import {
  ActualStateConflictError,
  ActualStateServiceError,
  ActualStateValidationFailedError,
  getLatestObservation,
  ingestObservation,
  InvalidProjectError,
} from "./actual-state.ts";

async function getLatestObservationForTransition(
  projectId: string,
  workloadId: string
): Promise<{ status: ObservedStatus; health: ObservedHealthStatus } | null> {
  const observation = await getLatestObservation(projectId, workloadId);
  if (!observation) {
    return null;
  }
  return { status: observation.status, health: observation.health.status };
}

export const DEFAULT_RUNTIME_STATUS_STALE_AFTER_MS = 5 * 60 * 1000;

export class RuntimeStatusServiceError extends Error {
  readonly code: "VALIDATION_FAILED";
  readonly validationErrors: ValidationError[];
  readonly causeError: unknown;

  constructor(validationErrors: ValidationError[], causeError?: unknown) {
    super("Runtime status report failed validation.");
    this.name = "RuntimeStatusServiceError";
    this.code = "VALIDATION_FAILED";
    this.validationErrors = validationErrors;
    this.causeError = causeError;
  }
}

export function reportToObservation(
  report: RuntimeStatusReport
): ActualStateObservation {
  const observation: ActualStateObservation = {
    observationId: report.reportId,
    projectId: report.projectId,
    workloadId: report.workloadId,
    source: report.source,
    observedAt: report.reportedAt,
    status: report.status,
    application: report.application,
    runtime: report.runtime,
    resources: report.resources,
    health: report.health,
  };
  if (report.environment !== undefined) {
    observation.environment = report.environment;
  }
  if (report.deployment !== undefined) {
    observation.deployment = report.deployment;
  }
  if (report.diagnostics !== undefined) {
    observation.diagnostics = report.diagnostics;
  }
  return observation;
}

export interface ReportRuntimeStatusOptions {
  logger?: Logger;
}

export interface StatusTransition {
  from: { status: ObservedStatus; health: ObservedHealthStatus };
  to: { status: ObservedStatus; health: ObservedHealthStatus };
}

export function detectStatusTransition(
  previous: { status: ObservedStatus; health: ObservedHealthStatus } | null,
  next: { status: ObservedStatus; health: ObservedHealthStatus }
): StatusTransition | null {
  if (!previous) {
    return null;
  }
  if (previous.status === next.status && previous.health === next.health) {
    return null;
  }
  return {
    from: { status: previous.status, health: previous.health },
    to: { status: next.status, health: next.health },
  };
}

export async function reportRuntimeStatus(
  input: RuntimeStatusReport,
  options: ReportRuntimeStatusOptions = {}
): Promise<RuntimeStatusView> {
  const logger = (options.logger ?? defaultLogger).child({
    component: "runtime-status",
    reportId:
      typeof input?.reportId === "string" ? input.reportId : undefined,
    projectId: typeof input?.projectId === "string" ? input.projectId : undefined,
    workloadId:
      typeof input?.workloadId === "string" ? input.workloadId : undefined,
    source: typeof input?.source === "string" ? input.source : undefined,
  });

  const validation = validateRuntimeStatusReport(input);
  if (!validation.valid || !validation.report) {
    logger.warn("runtime-status.report.rejected", {
      errorCount: validation.errors.length,
      errorPaths: validation.errors.map((error) => error.path),
    });
    throw new ActualStateValidationFailedError(validation.errors);
  }

  const report = validation.report;

  const previous = await getLatestObservationForTransition(
    report.projectId,
    report.workloadId
  );

  try {
    await ingestObservation(reportToObservation(report));
  } catch (error) {
    if (error instanceof ActualStateConflictError) {
      logger.warn("runtime-status.report.conflict", {
        reason: "duplicate-report",
      });
    } else {
      logger.error("runtime-status.report.failed", {
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage:
          error instanceof Error ? error.message : "unknown persistence failure",
      });
    }
    throw error;
  }

  const transition = detectStatusTransition(
    previous,
    { status: report.status, health: report.health.status }
  );
  if (transition) {
    logger.info("runtime-status.transition", {
      previousStatus: transition.from.status,
      previousHealth: transition.from.health,
      newStatus: transition.to.status,
      newHealth: transition.to.health,
    });
  }

  logger.info("runtime-status.report.recorded", {
    status: report.status,
    health: report.health.status,
    observedAt: report.reportedAt.toISOString(),
    transition: transition ? true : false,
  });

  const view = await getRuntimeStatus(report.projectId, report.workloadId, {
    now: report.reportedAt,
  });
  return view;
}

export interface GetRuntimeStatusOptions {
  now?: Date;
  staleAfterMs?: number;
}

function ensureNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeStatusServiceError([
      { path: field, message: `${field} must be a non-empty string` },
    ]);
  }
}

export async function getRuntimeStatus(
  projectId: string,
  workloadId: string,
  options: GetRuntimeStatusOptions = {}
): Promise<RuntimeStatusView> {
  ensureNonEmpty(projectId, "projectId");
  ensureNonEmpty(workloadId, "workloadId");
  const now = options.now ?? new Date();
  const staleAfterMs =
    options.staleAfterMs ?? DEFAULT_RUNTIME_STATUS_STALE_AFTER_MS;

  const observation = await getLatestObservation(projectId, workloadId);
  if (!observation) {
    return {
      availability: "unknown",
      projectId,
      workloadId,
      reason: "no-observations",
    };
  }

  const ageMs = Math.max(0, now.getTime() - observation.observedAt.getTime());
  return {
    availability: "known",
    projectId,
    workloadId,
    stale: ageMs > staleAfterMs,
    ageMs,
    observation: {
      observationId: observation.observationId,
      workloadId: observation.workloadId,
      source: observation.source,
      observedAt: observation.observedAt,
      recordedAt: observation.createdAt ?? observation.observedAt,
    },
    snapshot: toRuntimeStatusSnapshot(observation),
  };
}

export {
  ActualStateConflictError,
  ActualStateServiceError,
  ActualStateValidationFailedError,
  InvalidProjectError,
};
