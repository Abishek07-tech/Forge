import type { ActualStateObservation, ObservedStatus } from "../../types/actual-state.ts";
import type { DriftComparisonResult } from "../../types/drift.ts";
import { compareDesiredAndActual } from "../drift/comparison.ts";
import { getCurrentDesiredState } from "./desired-state.ts";
import { getLatestObservation } from "./actual-state.ts";

export type DriftServiceErrorCode = "VALIDATION_FAILED";

export class DriftServiceError extends Error {
  readonly code: DriftServiceErrorCode;

  constructor(code: DriftServiceErrorCode, message: string) {
    super(message);
    this.name = "DriftServiceError";
    this.code = code;
  }
}

export interface DesiredStateSummary {
  desiredStateId: string;
  version: number;
}

export interface ObservationSummary {
  observationId: string;
  workloadId: string;
  observedAt: Date;
  source: string;
  status: ObservedStatus;
}

export type ProjectDriftComparison =
  | {
      status: "no-desired-state";
      projectId: string;
      workloadId: string;
    }
  | {
      status: "no-observation";
      projectId: string;
      workloadId: string;
      desiredState: DesiredStateSummary;
    }
  | {
      status: "compared";
      projectId: string;
      workloadId: string;
      desiredState: DesiredStateSummary;
      observation: ObservationSummary;
      comparison: DriftComparisonResult;
    };

function ensureNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DriftServiceError(
      "VALIDATION_FAILED",
      `${field} must be a non-empty string.`
    );
  }
}

export async function compareProjectState(
  projectId: string,
  workloadId: string = "default"
): Promise<ProjectDriftComparison> {
  ensureNonEmpty(projectId, "projectId");
  ensureNonEmpty(workloadId, "workloadId");

  const desired = await getCurrentDesiredState(projectId);
  if (!desired) {
    return { status: "no-desired-state", projectId, workloadId };
  }

  const desiredState: DesiredStateSummary = {
    desiredStateId: desired.desiredStateId,
    version: desired.version,
  };

  const observation = await getLatestObservation(projectId, workloadId);
  if (!observation) {
    return { status: "no-observation", projectId, workloadId, desiredState };
  }

  const comparison = compareDesiredAndActual(desired, observation);

  return {
    status: "compared",
    projectId,
    workloadId,
    desiredState,
    observation: summarizeObservation(observation),
    comparison,
  };
}

function summarizeObservation(
  observation: ActualStateObservation
): ObservationSummary {
  return {
    observationId: observation.observationId,
    workloadId: observation.workloadId,
    observedAt: observation.observedAt,
    source: observation.source,
    status: observation.status,
  };
}
