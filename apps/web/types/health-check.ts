export type HealthCheckStatus =
  | "healthy"
  | "unhealthy"
  | "unknown"
  | "checking";

export type HealthProbeScheme = "http" | "https";

export interface HealthProbeTarget {
  scheme: HealthProbeScheme;
  host: string;
  port: number | null;
  path: string;
}

export type HealthProbeErrorKind =
  | "timeout"
  | "connection-refused"
  | "http-error"
  | "network-error";

export interface HealthProbeOutcome {
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  errorKind: HealthProbeErrorKind | null;
  errorMessage: string | null;
}

export type HealthCheckFailureKind =
  | HealthProbeErrorKind
  | "probe-error"
  | "incomplete-outcome";

export interface HealthCheckFailure {
  kind: HealthCheckFailureKind;
  message: string;
  statusCode: number | null;
}

export interface HealthCheckResult {
  checkId: string;
  projectId: string;
  workloadId: string;
  status: HealthCheckStatus;
  target: HealthProbeTarget;
  startedAt: Date;
  checkedAt: Date;
  durationMs: number;
  outcome: HealthProbeOutcome | null;
  failure: HealthCheckFailure | null;
}

export interface HealthCheckConfig {
  timeoutMs: number;
}
