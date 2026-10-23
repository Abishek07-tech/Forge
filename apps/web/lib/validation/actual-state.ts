export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const OBSERVED_STATUSES = ["running", "stopped", "failed", "unknown"];
const OBSERVED_HEALTH_STATUSES = ["healthy", "unhealthy", "unknown"];

export function validateActualStateObservation(
  input: unknown
): ValidationResult {
  const errors: ValidationError[] = [];
  const add = (path: string, message: string) =>
    errors.push({ path, message });

  if (!isPlainObject(input)) {
    add("observation", "Actual State observation must be an object");
    return { valid: false, errors };
  }

  const observation = input as Record<string, unknown>;

  addRequiredString(errors, observation, "observationId");
  addRequiredString(errors, observation, "projectId");
  addRequiredString(errors, observation, "workloadId");
  addRequiredString(errors, observation, "source");

  const observedAt = observation.observedAt;
  if (observedAt === undefined) {
    add("observedAt", "observedAt is required");
  } else if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    add("observedAt", "observedAt must be a valid Date");
  }

  addRequiredEnum(errors, observation, "status", OBSERVED_STATUSES);

  const application = observation.application;
  if (application === undefined) {
    add("application", "application is required");
  } else if (!isPlainObject(application)) {
    add("application", "application must be an object");
  } else {
    addNullableString(errors, application, "image", "application");
    addNullablePort(errors, application, "port", "application");
    if (
      application.version !== undefined &&
      typeof application.version !== "string"
    ) {
      add("application.version", "version must be a string");
    }
  }

  const runtime = observation.runtime;
  if (runtime === undefined) {
    add("runtime", "runtime is required");
  } else if (!isPlainObject(runtime)) {
    add("runtime", "runtime must be an object");
  } else {
    addNullableReplicas(errors, runtime, "replicas", "runtime");
  }

  const resources = observation.resources;
  if (resources === undefined) {
    add("resources", "resources is required");
  } else if (!isPlainObject(resources)) {
    add("resources", "resources must be an object");
  } else {
    addNullableString(errors, resources, "cpu", "resources");
    addNullableString(errors, resources, "memory", "resources");
  }

  if (observation.environment !== undefined) {
    if (!isPlainObject(observation.environment)) {
      add("environment", "environment must be an object");
    } else {
      for (const [key, value] of Object.entries(
        observation.environment as Record<string, unknown>
      )) {
        if (typeof value !== "string") {
          add(`environment.${key}`, `value for key "${key}" must be a string`);
        }
      }
    }
  }

  if (observation.deployment !== undefined) {
    if (!isPlainObject(observation.deployment)) {
      add("deployment", "deployment must be an object");
    } else {
      addNullableInteger(
        errors,
        observation.deployment as Record<string, unknown>,
        "version",
        "deployment"
      );
    }
  }

  const health = observation.health;
  if (health === undefined) {
    add("health", "health is required");
  } else if (!isPlainObject(health)) {
    add("health", "health must be an object");
  } else {
    addRequiredEnum(errors, health, "status", OBSERVED_HEALTH_STATUSES, "health");
  }

  if (observation.diagnostics !== undefined) {
    if (!isPlainObject(observation.diagnostics)) {
      add("diagnostics", "diagnostics must be an object");
    } else {
      const diagnostics = observation.diagnostics as Record<string, unknown>;
      if (
        diagnostics.message !== undefined &&
        typeof diagnostics.message !== "string"
      ) {
        add("diagnostics.message", "message must be a string");
      }
      if (
        diagnostics.reason !== undefined &&
        typeof diagnostics.reason !== "string"
      ) {
        add("diagnostics.reason", "reason must be a string");
      }
      if (diagnostics.details !== undefined) {
        if (!isPlainObject(diagnostics.details)) {
          add("diagnostics.details", "details must be an object");
        } else {
          for (const [key, value] of Object.entries(
            diagnostics.details as Record<string, unknown>
          )) {
            if (typeof value !== "string") {
              add(
                `diagnostics.details.${key}`,
                `value for key "${key}" must be a string`
              );
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addRequiredString(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  prefix?: string
): void {
  const path = prefix ? `${prefix}.${key}` : key;
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path, message: `${key} is required` });
  } else if (typeof value !== "string" || value.trim() === "") {
    errors.push({ path, message: `${key} must be a non-empty string` });
  }
}

function addRequiredEnum(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  allowed: string[],
  prefix?: string
): void {
  const path = prefix ? `${prefix}.${key}` : key;
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path, message: `${key} is required` });
  } else if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push({
      path,
      message: `${key} must be one of: ${allowed.join(", ")}`,
    });
  }
}

function addNullableString(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  prefix: string
): void {
  const path = `${prefix}.${key}`;
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path, message: `${key} is required (use null when unknown)` });
  } else if (value !== null && (typeof value !== "string" || value.trim() === "")) {
    errors.push({ path, message: `${key} must be a non-empty string or null` });
  }
}

function addNullablePort(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  prefix: string
): void {
  const path = `${prefix}.${key}`;
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path, message: `${key} is required (use null when unknown)` });
  } else if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 65535)
  ) {
    errors.push({
      path,
      message: `${key} must be an integer between 1 and 65535, or null`,
    });
  }
}

function addNullableReplicas(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  prefix: string
): void {
  const path = `${prefix}.${key}`;
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path, message: `${key} is required (use null when unknown)` });
  } else if (
    value !== null &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0)
  ) {
    errors.push({
      path,
      message: `${key} must be an integer greater than or equal to 0, or null`,
    });
  }
}

function addNullableInteger(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  prefix: string
): void {
  const path = `${prefix}.${key}`;
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path, message: `${key} is required (use null when unknown)` });
  } else if (
    value !== null &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0)
  ) {
    errors.push({
      path,
      message: `${key} must be an integer greater than or equal to 0, or null`,
    });
  }
}
