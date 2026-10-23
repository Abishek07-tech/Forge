import type { ActualStateObservation } from "../../types/actual-state.ts";
import type { RuntimeStatusReport } from "../../types/runtime-status.ts";
import {
  validateActualStateObservation,
  type ValidationError,
} from "./actual-state.ts";

export interface RuntimeStatusValidationResult {
  valid: boolean;
  errors: ValidationError[];
  report?: RuntimeStatusReport;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRuntimeStatusReport(
  input: unknown
): RuntimeStatusValidationResult {
  const errors: ValidationError[] = [];
  const add = (path: string, message: string) =>
    errors.push({ path, message });

  if (!isPlainObject(input)) {
    add("report", "Runtime status report must be an object");
    return { valid: false, errors };
  }

  const body = input as Record<string, unknown>;

  for (const key of ["reportId", "projectId", "workloadId", "source"]) {
    const value = body[key];
    if (value === undefined) {
      add(key, `${key} is required`);
    } else if (typeof value !== "string" || value.trim() === "") {
      add(key, `${key} must be a non-empty string`);
    }
  }

  if (body.reportedAt === undefined) {
    add("reportedAt", "reportedAt is required");
  } else if (
    !(body.reportedAt instanceof Date) ||
    Number.isNaN(body.reportedAt.getTime())
  ) {
    add("reportedAt", "reportedAt must be a valid Date");
  }

  const candidate: ActualStateObservation = {
    observationId:
      typeof body.reportId === "string" ? body.reportId : "invalid",
    projectId: typeof body.projectId === "string" ? body.projectId : "invalid",
    workloadId:
      typeof body.workloadId === "string" ? body.workloadId : "invalid",
    source: typeof body.source === "string" ? body.source : "invalid",
    observedAt:
      body.reportedAt instanceof Date
        ? body.reportedAt
        : new Date(Number.NaN),
    status: body.status as ActualStateObservation["status"],
    application: body.application as ActualStateObservation["application"],
    runtime: body.runtime as ActualStateObservation["runtime"],
    resources: body.resources as ActualStateObservation["resources"],
    health: body.health as ActualStateObservation["health"],
  };
  if (body.environment !== undefined) {
    candidate.environment =
      body.environment as ActualStateObservation["environment"];
  }
  if (body.deployment !== undefined) {
    candidate.deployment =
      body.deployment as ActualStateObservation["deployment"];
  }
  if (body.diagnostics !== undefined) {
    candidate.diagnostics =
      body.diagnostics as ActualStateObservation["diagnostics"];
  }

  const domainResult = validateActualStateObservation(candidate);
  const seen = new Set(errors.map((error) => error.path));
  for (const error of domainResult.errors) {
    const mappedPath =
      error.path === "observationId"
        ? "reportId"
        : error.path === "observedAt"
          ? "reportedAt"
          : error.path;
    if (mappedPath !== "projectId" && !seen.has(mappedPath)) {
      errors.push({ ...error, path: mappedPath });
      seen.add(mappedPath);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const report: RuntimeStatusReport = {
    reportId: candidate.observationId,
    projectId: candidate.projectId,
    workloadId: candidate.workloadId,
    source: candidate.source,
    reportedAt: candidate.observedAt,
    status: candidate.status,
    application: candidate.application,
    runtime: candidate.runtime,
    resources: candidate.resources,
    health: candidate.health,
  };
  if (candidate.environment !== undefined) {
    report.environment = candidate.environment;
  }
  if (candidate.deployment !== undefined) {
    report.deployment = candidate.deployment;
  }
  if (candidate.diagnostics !== undefined) {
    report.diagnostics = candidate.diagnostics;
  }

  return { valid: true, errors: [], report };
}
