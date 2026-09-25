export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateDesiredState(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const add = (path: string, message: string) =>
    errors.push({ path, message });

  if (!isPlainObject(input)) {
    add("desiredState", "Desired State must be an object");
    return { valid: false, errors };
  }

  const state = input as Record<string, unknown>;

  addRequiredString(errors, state, "desiredStateId");
  addRequiredString(errors, state, "projectId");

  const version = state.version;
  if (version === undefined) {
    add("version", "version is required");
  } else if (typeof version !== "number" || !Number.isInteger(version)) {
    add("version", "version must be an integer");
  } else if (version < 1) {
    add("version", "version must be at least 1");
  }

  for (const key of ["createdAt", "updatedAt"]) {
    const value = state[key];
    if (value !== undefined && !(value instanceof Date)) {
      add(key, `${key} must be a Date`);
    }
  }

  const applications = state.applications;
  if (applications === undefined) {
    add("applications", "applications is required");
  } else if (!isPlainObject(applications)) {
    add("applications", "applications must be an object");
  } else {
    const app = applications as Record<string, unknown>;
    addRequiredString(errors, app, "image", "applications");
    if (app.version !== undefined && typeof app.version !== "string") {
      add("applications.version", "version must be a string");
    }
    addRequiredPort(errors, app, "port", "applications");
    if (app.protocol !== undefined && typeof app.protocol !== "string") {
      add("applications.protocol", "protocol must be a string");
    }
  }

  const runtime = state.runtime;
  if (runtime === undefined) {
    add("runtime", "runtime is required");
  } else if (!isPlainObject(runtime)) {
    add("runtime", "runtime must be an object");
  } else {
    const replicas = (runtime as Record<string, unknown>).replicas;
    if (replicas === undefined) {
      add("runtime.replicas", "replicas is required");
    } else if (
      typeof replicas !== "number" ||
      !Number.isInteger(replicas) ||
      replicas < 1
    ) {
      add("runtime.replicas", "replicas must be an integer greater than or equal to 1");
    }
  }

  const resources = state.resources;
  if (resources === undefined) {
    add("resources", "resources is required");
  } else if (!isPlainObject(resources)) {
    add("resources", "resources must be an object");
  } else {
    addRequiredString(errors, resources as Record<string, unknown>, "cpu", "resources");
    addRequiredString(errors, resources as Record<string, unknown>, "memory", "resources");
  }

  if (state.environment !== undefined) {
    if (!isPlainObject(state.environment)) {
      add("environment", "environment must be an object");
    } else {
      for (const [key, value] of Object.entries(
        state.environment as Record<string, unknown>
      )) {
        if (typeof value !== "string") {
          add(`environment.${key}`, `value for key "${key}" must be a string`);
        }
      }
    }
  }

  if (state.deployment !== undefined) {
    if (!isPlainObject(state.deployment)) {
      add("deployment", "deployment must be an object");
    } else {
      const deploymentVersion = (state.deployment as Record<string, unknown>).version;
      if (deploymentVersion === undefined) {
        add("deployment.version", "version is required");
      } else if (
        typeof deploymentVersion !== "number" ||
        !Number.isInteger(deploymentVersion)
      ) {
        add("deployment.version", "version must be an integer");
      }
    }
  }

  const health = state.health;
  if (health === undefined) {
    add("health", "health is required");
  } else if (!isPlainObject(health)) {
    add("health", "health must be an object");
  } else {
    addRequiredString(errors, health as Record<string, unknown>, "path", "health");
    addOptionalPort(errors, health as Record<string, unknown>, "port", "health");
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

function addRequiredPort(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  prefix: string
): void {
  const value = obj[key];
  if (value === undefined) {
    errors.push({ path: `${prefix}.${key}`, message: `${key} is required` });
  } else {
    addOptionalPort(errors, obj, key, prefix);
  }
}

function addOptionalPort(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  prefix: string
): void {
  const value = obj[key];
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 65535)
  ) {
    errors.push({
      path: `${prefix}.${key}`,
      message: `${key} must be an integer between 1 and 65535`,
    });
  }
}