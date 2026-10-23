export type DriftCategory =
  | "missing"
  | "extra"
  | "changed"
  | "unhealthy"
  | "configuration-mismatch"
  | "version-mismatch";

export type DriftProperty =
  | "application.image"
  | "application.port"
  | "application.version"
  | "runtime.replicas"
  | "resources.cpu"
  | "resources.memory"
  | "environment"
  | "deployment.version"
  | "health.status";

export type DriftValue = string | number;

export interface DriftFinding {
  property: DriftProperty;
  category: DriftCategory;
  explanation: string;
  desiredValue?: DriftValue;
  observedValue?: DriftValue;
}

export type DriftComparisonOutcome = "match" | "drift" | "insufficient-data";

export interface DriftComparisonResult {
  projectId: string;
  workloadId: string;
  outcome: DriftComparisonOutcome;
  findings: DriftFinding[];
  unknownProperties: DriftProperty[];
  comparedProperties: DriftProperty[];
}
