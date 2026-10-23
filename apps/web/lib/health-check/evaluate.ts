import { randomUUID } from "node:crypto";
import type {
  HealthCheckConfig,
  HealthCheckFailure,
  HealthCheckResult,
  HealthCheckStatus,
  HealthProbeOutcome,
  HealthProbeTarget,
} from "../../types/health-check.ts";
import { defaultLogger, type Logger } from "../observability/logger.ts";
import type { HealthProbe } from "./probe.ts";

export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;

export interface HealthCheckContext {
  projectId: string;
  workloadId: string;
  target: HealthProbeTarget;
}

export interface RunHealthCheckOptions {
  config?: Partial<HealthCheckConfig>;
  now?: () => Date;
  generateCheckId?: () => string;
  logger?: Logger;
}

export class HealthCheckValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HealthCheckValidationError";
  }
}

function ensureNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HealthCheckValidationError(`${field} must be a non-empty string.`);
  }
}

export function ensureValidHealthCheckContext(
  context: HealthCheckContext
): void {
  ensureNonEmpty(context.projectId, "projectId");
  ensureNonEmpty(context.workloadId, "workloadId");
  ensureNonEmpty(context.target.path, "target.path");
  ensureNonEmpty(context.target.host, "target.host");
  if (
    context.target.port !== null &&
    (!Number.isInteger(context.target.port) ||
      context.target.port < 1 ||
      context.target.port > 65535)
  ) {
    throw new HealthCheckValidationError(
      "target.port must be an integer between 1 and 65535, or null."
    );
  }
  if (context.target.scheme !== "http" && context.target.scheme !== "https") {
    throw new HealthCheckValidationError(
      'target.scheme must be "http" or "https".'
    );
  }
}

function classifyOutcome(outcome: HealthProbeOutcome): {
  status: HealthCheckStatus;
  failure: HealthCheckFailure | null;
} {
  if (outcome.reachable === true && outcome.statusCode !== null) {
    if (outcome.statusCode >= 200 && outcome.statusCode < 300) {
      return { status: "healthy", failure: null };
    }
    return {
      status: "unhealthy",
      failure: {
        kind: "http-error",
        message: `Health endpoint responded with status ${outcome.statusCode}.`,
        statusCode: outcome.statusCode,
      },
    };
  }
  if (outcome.errorKind !== null) {
    const message =
      outcome.errorMessage ?? `Health probe failed (${outcome.errorKind}).`;
    return {
      status: "unhealthy",
      failure: {
        kind: outcome.errorKind,
        message,
        statusCode: outcome.statusCode,
      },
    };
  }
  return {
    status: "unknown",
    failure: {
      kind: "incomplete-outcome",
      message:
        "Health probe returned an incomplete outcome; health cannot be determined.",
      statusCode: null,
    },
  };
}

export function evaluateHealthOutcome(
  outcome: HealthProbeOutcome
): { status: HealthCheckStatus; failure: HealthCheckFailure | null } {
  return classifyOutcome(outcome);
}

function raceWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, timeoutMs);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function runHealthCheck(
  probe: HealthProbe,
  context: HealthCheckContext,
  options: RunHealthCheckOptions = {}
): Promise<HealthCheckResult> {
  ensureValidHealthCheckContext(context);

  const now = options.now ?? (() => new Date());
  const generateCheckId = options.generateCheckId ?? (() => randomUUID());
  const timeoutMs = Math.max(
    1,
    options.config?.timeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS
  );
  const checkId = generateCheckId();
  const logger = (options.logger ?? defaultLogger).child({
    component: "health-check",
    checkId,
    projectId: context.projectId,
    workloadId: context.workloadId,
    targetPath: context.target.path,
    targetPort: context.target.port,
  });

  const startedAt = now();

  logger.debug("health-check.started", { timeoutMs });

  let outcome: HealthProbeOutcome | null = null;
  let failure: HealthCheckFailure | null = null;
  let status: HealthCheckStatus;

  try {
    const raced = await raceWithTimeout(probe.probe(context.target), timeoutMs);
    if (raced.timedOut) {
      outcome = {
        reachable: false,
        statusCode: null,
        latencyMs: null,
        errorKind: "timeout",
        errorMessage: `Health probe did not complete within ${timeoutMs}ms.`,
      };
      const classified = classifyOutcome(outcome);
      status = classified.status;
      failure = classified.failure;
    } else {
      outcome = raced.value;
      const classified = classifyOutcome(outcome);
      status = classified.status;
      failure = classified.failure;
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Health probe threw an error.";
    outcome = {
      reachable: false,
      statusCode: null,
      latencyMs: null,
      errorKind: "network-error",
      errorMessage: message,
    };
    status = "unhealthy";
    failure = {
      kind: "probe-error",
      message: `Health probe failed: ${message}`,
      statusCode: null,
    };
  }

  const checkedAt = now();
  const durationMs = Math.max(0, checkedAt.getTime() - startedAt.getTime());

  const completionContext = {
    status,
    durationMs,
    httpStatus: outcome?.statusCode ?? null,
    failureKind: failure?.kind ?? null,
    failureMessage: failure?.message ?? null,
  };
  if (status === "healthy") {
    logger.info("health-check.completed", completionContext);
  } else {
    logger.warn("health-check.completed", completionContext);
  }

  return {
    checkId,
    projectId: context.projectId,
    workloadId: context.workloadId,
    status,
    target: context.target,
    startedAt,
    checkedAt,
    durationMs,
    outcome,
    failure,
  };
}

export function isChecking(status: HealthCheckStatus): boolean {
  return status === "checking";
}
