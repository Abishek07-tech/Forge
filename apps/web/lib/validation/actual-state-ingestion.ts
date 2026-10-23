import type { ActualStateObservation } from "../../types/actual-state.ts";
import {
  validateActualStateObservation,
  type ValidationError,
} from "./actual-state.ts";

export interface IngestionValidationResult {
  valid: boolean;
  errors: ValidationError[];
  observation?: ActualStateObservation;
}

const OBSERVED_STATUSES = ["running", "stopped", "failed", "unknown"];
const OBSERVED_HEALTH_STATUSES = ["healthy", "unhealthy", "unknown"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObservedAt(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  if (!value.includes("T")) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function copyOptional<T>(value: unknown): T | undefined {
  return value === undefined ? undefined : (value as T);
}

export function validateObservationIngestion(
  input: unknown
): IngestionValidationResult {
  const errors: ValidationError[] = [];
  const add = (path: string, message: string) =>
    errors.push({ path, message });

  if (!isPlainObject(input)) {
    add("observation", "Actual State observation must be an object");
    return { valid: false, errors };
  }

  const body = input as Record<string, unknown>;

  for (const key of ["observationId", "workloadId", "source"]) {
    const value = body[key];
    if (value === undefined) {
      add(key, `${key} is required`);
    } else if (typeof value !== "string" || value.trim() === "") {
      add(key, `${key} must be a non-empty string`);
    }
  }

  const observedAtValue = body.observedAt;
  let observedAt: Date | null = null;
  if (observedAtValue === undefined) {
    add("observedAt", "observedAt is required");
  } else {
    observedAt = parseObservedAt(observedAtValue);
    if (observedAt === null) {
      add(
        "observedAt",
        "observedAt must be a valid ISO 8601 date-time string"
      );
    }
  }

  const status = body.status;
  if (status === undefined) {
    add("status", "status is required");
  } else if (
    typeof status !== "string" ||
    !OBSERVED_STATUSES.includes(status)
  ) {
    add("status", `status must be one of: ${OBSERVED_STATUSES.join(", ")}`);
  }

  if (body.application === undefined) {
    add("application", "application is required");
  } else if (!isPlainObject(body.application)) {
    add("application", "application must be an object");
  }

  if (body.runtime === undefined) {
    add("runtime", "runtime is required");
  } else if (!isPlainObject(body.runtime)) {
    add("runtime", "runtime must be an object");
  }

  if (body.resources === undefined) {
    add("resources", "resources is required");
  } else if (!isPlainObject(body.resources)) {
    add("resources", "resources must be an object");
  }

  const health = body.health;
  if (health === undefined) {
    add("health", "health is required");
  } else if (!isPlainObject(health)) {
    add("health", "health must be an object");
  } else {
    const healthStatus = health.status;
    if (healthStatus === undefined) {
      add("health.status", "status is required");
    } else if (
      typeof healthStatus !== "string" ||
      !OBSERVED_HEALTH_STATUSES.includes(healthStatus)
    ) {
      add(
        "health.status",
        `status must be one of: ${OBSERVED_HEALTH_STATUSES.join(", ")}`
      );
    }
  }

  if (body.environment !== undefined && !isPlainObject(body.environment)) {
    add("environment", "environment must be an object");
  }

  if (body.deployment !== undefined && !isPlainObject(body.deployment)) {
    add("deployment", "deployment must be an object");
  }

  const canConstruct =
    typeof body.observationId === "string" &&
    body.observationId.trim() !== "" &&
    typeof body.workloadId === "string" &&
    body.workloadId.trim() !== "" &&
    typeof body.source === "string" &&
    body.source.trim() !== "" &&
    observedAt !== null &&
    typeof status === "string" &&
    OBSERVED_STATUSES.includes(status) &&
    isPlainObject(body.application) &&
    isPlainObject(body.runtime) &&
    isPlainObject(body.resources) &&
    isPlainObject(body.health);

  if (canConstruct) {
    const candidate: ActualStateObservation = {
      observationId: body.observationId as string,
      projectId: "",
      workloadId: body.workloadId as string,
      source: body.source as string,
      observedAt: observedAt as Date,
      status: status as ActualStateObservation["status"],
      application: body.application as ActualStateObservation["application"],
      runtime: body.runtime as ActualStateObservation["runtime"],
      resources: body.resources as ActualStateObservation["resources"],
      health: body.health as ActualStateObservation["health"],
      ...(copyOptional(body.environment) !== undefined
        ? { environment: copyOptional(body.environment) }
        : {}),
      ...(copyOptional(body.deployment) !== undefined
        ? { deployment: copyOptional(body.deployment) }
        : {}),
      ...(copyOptional(body.diagnostics) !== undefined
        ? { diagnostics: copyOptional(body.diagnostics) }
        : {}),
    };

    const domainResult = validateActualStateObservation(candidate);
    const filteredDomainErrors = domainResult.errors.filter(
      (error) => error.path !== "projectId" && error.path !== "observedAt"
    );
    errors.push(...filteredDomainErrors);

    if (errors.length === 0) {
      return { valid: true, errors: [], observation: candidate };
    }
  } else {
    validateNestedFields(body, errors);
  }

  return { valid: false, errors };
}

function validateNestedFields(
  body: Record<string, unknown>,
  errors: ValidationError[]
): void {
  const add = (path: string, message: string) =>
    errors.push({ path, message });

  if (isPlainObject(body.application)) {
    const app = body.application;
    if (
      app.image !== undefined &&
      app.image !== null &&
      (typeof app.image !== "string" || app.image.trim() === "")
    ) {
      add("application.image", "image must be a non-empty string or null");
    }
    if (
      app.port !== undefined &&
      app.port !== null &&
      (typeof app.port !== "number" ||
        !Number.isInteger(app.port) ||
        app.port < 1 ||
        app.port > 65535)
    ) {
      add(
        "application.port",
        "port must be an integer between 1 and 65535, or null"
      );
    }
    if (app.version !== undefined && typeof app.version !== "string") {
      add("application.version", "version must be a string");
    }
  }

  if (isPlainObject(body.runtime)) {
    const rt = body.runtime;
    if (
      rt.replicas !== undefined &&
      rt.replicas !== null &&
      (typeof rt.replicas !== "number" ||
        !Number.isInteger(rt.replicas) ||
        rt.replicas < 0)
    ) {
      add(
        "runtime.replicas",
        "replicas must be an integer greater than or equal to 0, or null"
      );
    }
  }

  if (isPlainObject(body.resources)) {
    const res = body.resources;
    for (const key of ["cpu", "memory"]) {
      const value = res[key];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.trim() === "")
      ) {
        add(`resources.${key}`, `${key} must be a non-empty string or null`);
      }
    }
  }

  if (isPlainObject(body.environment)) {
    for (const [key, value] of Object.entries(body.environment)) {
      if (typeof value !== "string") {
        add(`environment.${key}`, `value for key "${key}" must be a string`);
      }
    }
  }

  if (isPlainObject(body.deployment)) {
    const dep = body.deployment;
    if (
      dep.version !== undefined &&
      dep.version !== null &&
      (typeof dep.version !== "number" ||
        !Number.isInteger(dep.version) ||
        dep.version < 0)
    ) {
      add(
        "deployment.version",
        "version must be an integer greater than or equal to 0, or null"
      );
    }
  }
}
