import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import { validateActualStateObservation } from "./actual-state.ts";

function validObservation(): Record<string, unknown> {
  return {
    observationId: "obs_01",
    projectId: "prj_42",
    workloadId: "default",
    source: "test-harness",
    observedAt: new Date("2026-10-17T00:00:00Z"),
    status: "running",
    application: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
    health: { status: "healthy" },
  };
}

function paths(result: { errors: { path: string }[] }): string[] {
  return result.errors.map((error) => error.path);
}

test("valid observation passes", () => {
  const result = validateActualStateObservation(validObservation());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("a fully unknown observation passes — unknown is not absence", () => {
  const observation: Record<string, unknown> = {
    observationId: "obs_01",
    projectId: "prj_42",
    workloadId: "default",
    source: "test-harness",
    observedAt: new Date("2026-10-17T00:00:00Z"),
    status: "unknown",
    application: { image: null, port: null },
    runtime: { replicas: null },
    resources: { cpu: null, memory: null },
    deployment: { version: null },
    health: { status: "unknown" },
  };
  const result = validateActualStateObservation(observation);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("observed zero replicas is valid and distinct from unknown", () => {
  const observation = { ...validObservation(), runtime: { replicas: 0 } };
  const result = validateActualStateObservation(observation);
  assert.equal(result.valid, true);

  const negative = { ...validObservation(), runtime: { replicas: -1 } };
  const negativeResult = validateActualStateObservation(negative);
  assert.equal(negativeResult.valid, false);
  assert.ok(paths(negativeResult).includes("runtime.replicas"));
});

test("missing observed fields fail — required, use null when unknown", () => {
  const observation = validObservation();
  delete observation.application;
  delete observation.runtime;
  delete observation.resources;
  delete observation.health;
  const result = validateActualStateObservation(observation);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), [
    "application",
    "runtime",
    "resources",
    "health",
  ]);
});

test("missing image/port/replicas fail rather than defaulting to null", () => {
  const observation = {
    ...validObservation(),
    application: {},
    runtime: {},
    resources: {},
  };
  const result = validateActualStateObservation(observation);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), [
    "application.image",
    "application.port",
    "runtime.replicas",
    "resources.cpu",
    "resources.memory",
  ]);
});

test("missing identity fields fail", () => {
  for (const key of [
    "observationId",
    "projectId",
    "workloadId",
    "source",
    "observedAt",
    "status",
  ]) {
    const observation = validObservation();
    delete observation[key];
    const result = validateActualStateObservation(observation);
    assert.equal(result.valid, false, `${key} should be required`);
    assert.deepEqual(paths(result), [key]);
  }
});

test("invalid status values fail", () => {
  for (const status of ["active", "", 42, null]) {
    const observation = { ...validObservation(), status };
    const result = validateActualStateObservation(observation);
    assert.equal(result.valid, false, `status=${String(status)}`);
    assert.deepEqual(paths(result), ["status"]);
  }
});

test("invalid health status values fail", () => {
  const observation = {
    ...validObservation(),
    health: { status: "degraded" },
  };
  const result = validateActualStateObservation(observation);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ["health.status"]);
});

test("invalid observedAt fails", () => {
  for (const observedAt of ["2026-10-17", new Date("invalid"), 123]) {
    const observation = { ...validObservation(), observedAt };
    const result = validateActualStateObservation(observation);
    assert.equal(result.valid, false, `observedAt=${String(observedAt)}`);
    assert.deepEqual(paths(result), ["observedAt"]);
  }
});

test("port out of range fails but null port passes", () => {
  const bad = {
    ...validObservation(),
    application: { image: "forge-api:v1", port: 70000 },
  };
  const badResult = validateActualStateObservation(bad);
  assert.equal(badResult.valid, false);
  assert.deepEqual(paths(badResult), ["application.port"]);

  const nulled = {
    ...validObservation(),
    application: { image: "forge-api:v1", port: null },
  };
  assert.equal(validateActualStateObservation(nulled).valid, true);
});

test("non-string environment values fail", () => {
  const observation = {
    ...validObservation(),
    environment: { REPLICA_COUNT: 3 },
  };
  const result = validateActualStateObservation(observation);
  assert.equal(result.valid, false);
  assert.deepEqual(paths(result), ["environment.REPLICA_COUNT"]);
});

test("non-object environment or deployment fails", () => {
  const badEnvironment = { ...validObservation(), environment: "prod" };
  assert.deepEqual(paths(validateActualStateObservation(badEnvironment)), [
    "environment",
  ]);

  const badDeployment = { ...validObservation(), deployment: 3 };
  assert.deepEqual(paths(validateActualStateObservation(badDeployment)), [
    "deployment",
  ]);
});

test("non-object input is rejected", () => {
  assert.equal(validateActualStateObservation("not-an-observation").valid, false);
  assert.equal(validateActualStateObservation(null).valid, false);
  assert.equal(validateActualStateObservation([validObservation()]).valid, false);
});

test("multiple errors are all reported with paths and messages", () => {
  const observation = {
    observationId: "",
    status: "mystery",
    runtime: { replicas: -2 },
  };
  const result = validateActualStateObservation(observation);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 5);
  for (const error of result.errors) {
    assert.ok(error.path.length > 0);
    assert.ok(error.message.length > 0);
  }
});

test("domain type accepts nulls for unknown observed values", () => {
  const observation: ActualStateObservation = {
    observationId: "obs_typed",
    projectId: "prj_42",
    workloadId: "default",
    source: "test-harness",
    observedAt: new Date("2026-10-17T00:00:00Z"),
    status: "unknown",
    application: { image: null, port: null },
    runtime: { replicas: null },
    resources: { cpu: null, memory: null },
    health: { status: "unknown" },
  };
  assert.equal(validateActualStateObservation(observation).valid, true);
  assert.equal(observation.application.image, null);
  assert.equal(observation.runtime.replicas, null);
});
