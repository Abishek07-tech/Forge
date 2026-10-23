import type {
  ActualStateObservation,
  Environment,
  ObservedApplication,
  ObservedDeployment,
  ObservedHealth,
  ObservedResources,
  ObservedRuntime,
  ObservedStatus,
  RuntimeDiagnostics,
} from "./actual-state.ts";

export interface RuntimeStatusReport {
  reportId: string;
  projectId: string;
  workloadId: string;
  source: string;
  reportedAt: Date;
  status: ObservedStatus;
  application: ObservedApplication;
  runtime: ObservedRuntime;
  resources: ObservedResources;
  environment?: Environment;
  deployment?: ObservedDeployment;
  health: ObservedHealth;
  diagnostics?: RuntimeDiagnostics;
}

export interface RuntimeStatusObservationRef {
  observationId: string;
  workloadId: string;
  source: string;
  observedAt: Date;
  recordedAt: Date;
}

export interface RuntimeStatusSnapshot {
  status: ObservedStatus;
  health: ObservedHealth;
  application: ObservedApplication;
  runtime: ObservedRuntime;
  resources: ObservedResources;
  environment?: Environment;
  deployment?: ObservedDeployment;
  diagnostics?: RuntimeDiagnostics;
}

export type RuntimeStatusView =
  | {
      availability: "unknown";
      projectId: string;
      workloadId: string;
      reason: "no-observations";
    }
  | {
      availability: "known";
      projectId: string;
      workloadId: string;
      stale: boolean;
      ageMs: number;
      observation: RuntimeStatusObservationRef;
      snapshot: RuntimeStatusSnapshot;
    };

export function toRuntimeStatusSnapshot(
  observation: ActualStateObservation
): RuntimeStatusSnapshot {
  const snapshot: RuntimeStatusSnapshot = {
    status: observation.status,
    health: observation.health,
    application: observation.application,
    runtime: observation.runtime,
    resources: observation.resources,
  };
  if (observation.environment !== undefined) {
    snapshot.environment = observation.environment;
  }
  if (observation.deployment !== undefined) {
    snapshot.deployment = observation.deployment;
  }
  if (observation.diagnostics !== undefined) {
    snapshot.diagnostics = observation.diagnostics;
  }
  return snapshot;
}
