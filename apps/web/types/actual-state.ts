import type { Environment } from "./desired-state.ts";
export type { Environment };

export type ObservedStatus = "running" | "stopped" | "failed" | "unknown";

export type ObservedHealthStatus = "healthy" | "unhealthy" | "unknown";

export interface ObservedApplication {
  image: string | null;
  port: number | null;
  version?: string;
}

export interface ObservedRuntime {
  replicas: number | null;
}

export interface ObservedResources {
  cpu: string | null;
  memory: string | null;
}

export interface ObservedDeployment {
  version: number | null;
}

export interface ObservedHealth {
  status: ObservedHealthStatus;
}

export interface ActualStateObservation {
  observationId: string;
  projectId: string;
  workloadId: string;
  source: string;
  observedAt: Date;
  status: ObservedStatus;
  application: ObservedApplication;
  runtime: ObservedRuntime;
  resources: ObservedResources;
  environment?: Environment;
  deployment?: ObservedDeployment;
  health: ObservedHealth;
}
