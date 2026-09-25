import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateDesiredState } from "./desired-state.ts";

function validState(): Record<string, unknown> {
  return {
    desiredStateId: "ds_01",
    projectId: "prj_42",
    version: 1,
    createdAt: new Date("2026-09-25T00:00:00Z"),
    updatedAt: new Date("2026-09-25T00:00:00Z"),
    applications: { image: "forge-api:v2", port: 8080 },
    runtime: { replicas: 3 },
    resources: { cpu: "500m", memory: "512Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 2 },
    health: { path: "/health" },
  };
}

function paths(result: { errors: { path: string }[] }): string[] {
  return result.errors.map((error) => error.path);
}

test("valid Desired State passes", () => {
  const result = validateDesiredState(validState());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("missing projectId fails", () => {
  const state = validState();
  delete state.projectId;
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ["projectId"]);
});

test("missing desiredStateId fails", () => {
  const state = validState();
  delete state.desiredStateId;
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ["desiredStateId"]);
});

test("missing version fails", () => {
  const state = validState();
  delete state.version;
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ["version"]);
});

test("version must be at least 1", () => {
  const state = validState();
  state.version = 0;
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors[0].path, "version");
  assert.match(result.errors[0].message, /at least 1/);
});

test("missing required Desired State section fails", () => {
  for (const section of ["applications", "runtime", "resources", "health"]) {
    const state = validState();
    delete state[section];
    const result = validateDesiredState(state);
    assert.equal(result.valid, false, `section ${section} should be required`);
    assert.deepEqual(paths(result), [section]);
  }
});

test("optional sections may be absent", () => {
  const state = validState();
  delete state.environment;
  delete state.deployment;
  const result = validateDesiredState(state);
  assert.equal(result.valid, true);
});

test("invalid nested structure fails", () => {
  const state = validState();
  state.applications = { image: "forge-api:v2", port: "8080" };
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ["applications.port"]);
});

test("invalid replicas fails", () => {
  const state = validState();
  state.runtime = { replicas: 0 };
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors[0].path, "runtime.replicas");
});

test("empty required string fails", () => {
  const state = validState();
  state.applications = { image: "   ", port: 8080 };
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors[0].path, "applications.image");
});

test("non-object environment value fails", () => {
  const state = validState();
  state.environment = { NODE_ENV: "production", TRACE: 42 };
  const result = validateDesiredState(state);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ["environment.TRACE"]);
});

test("non-object inputs fail at the root", () => {
  for (const input of [null, undefined, [], "not an object", 42]) {
    const result = validateDesiredState(input);
    assert.equal(result.valid, false);
    assert.deepEqual(paths(result), ["desiredState"]);
  }
});

test("multiple validation errors are reported together", () => {
  const result = validateDesiredState({
    applications: { image: "", port: 0 },
    runtime: { replicas: 0 },
    resources: { cpu: "", memory: "512Mi" },
    health: { path: "" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 4);
  const reported = paths(result);
  assert.ok(reported.includes("desiredStateId"));
  assert.ok(reported.includes("projectId"));
  assert.ok(reported.includes("version"));
  assert.ok(reported.includes("applications.image"));
  assert.ok(reported.includes("applications.port"));
  assert.ok(reported.includes("runtime.replicas"));
  assert.ok(reported.includes("resources.cpu"));
  assert.ok(reported.includes("health.path"));
});