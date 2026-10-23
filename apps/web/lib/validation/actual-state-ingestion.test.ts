import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateObservationIngestion } from "./actual-state-ingestion.ts";

function validIngestionBody(): Record<string, unknown> {
  return {
    observationId: "obs_ing_01",
    workloadId: "default",
    source: "test-harness",
    observedAt: "2026-10-18T10:00:00Z",
    status: "running",
    application: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    health: { status: "healthy" },
  };
}

function paths(result: { errors: { path: string }[] }): string[] {
  return result.errors.map((error) => error.path);
}

test("valid ingestion body passes and yields a domain observation", () => {
  const result = validateObservationIngestion(validIngestionBody());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.observation);
  assert.equal(result.observation.observationId, "obs_ing_01");
  assert.equal(result.observation.workloadId, "default");
  assert.equal(result.observation.source, "test-harness");
  assert.ok(result.observation.observedAt instanceof Date);
  assert.equal(
    result.observation.observedAt.getTime(),
    Date.parse("2026-10-18T10:00:00Z")
  );
  assert.equal(result.observation.status, "running");
  assert.ok(!("environment" in result.observation));
  assert.ok(!("deployment" in result.observation));
});

test("optional environment and deployment groups pass when absent", () => {
  const body = validIngestionBody();
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, true);
  assert.ok(result.observation);
  assert.ok(!("environment" in result.observation));
  assert.ok(!("deployment" in result.observation));
});

test("optional environment and deployment groups pass when present", () => {
  const body = {
    ...validIngestionBody(),
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
  };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, true);
  assert.ok(result.observation);
  assert.deepEqual(result.observation.environment, { NODE_ENV: "production" });
  assert.deepEqual(result.observation.deployment, { version: 1 });
});

test("missing required top-level fields fail", () => {
  for (const key of [
    "observationId",
    "workloadId",
    "source",
    "observedAt",
    "status",
    "application",
    "runtime",
    "resources",
    "health",
  ]) {
    const body = validIngestionBody();
    delete body[key];
    const result = validateObservationIngestion(body);
    assert.equal(result.valid, false, `${key} should be required`);
    assert.ok(paths(result).includes(key), `${key} path expected`);
  }
});

test("empty required strings fail", () => {
  for (const key of ["observationId", "workloadId", "source"]) {
    const body = { ...validIngestionBody(), [key]: "" };
    const result = validateObservationIngestion(body);
    assert.equal(result.valid, false, `${key}="" should fail`);
    assert.ok(paths(result).includes(key));
  }
});

test("whitespace-only required strings fail", () => {
  const body = { ...validIngestionBody(), source: "   " };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, false);
  assert.ok(paths(result).includes("source"));
});

test("invalid status values fail", () => {
  for (const status of ["active", "", 42, null, "RUNNING"]) {
    const body = { ...validIngestionBody(), status };
    const result = validateObservationIngestion(body);
    assert.equal(result.valid, false, `status=${String(status)}`);
    assert.ok(paths(result).includes("status"));
  }
});

test("invalid health status values fail", () => {
  const body = {
    ...validIngestionBody(),
    health: { status: "degraded" },
  };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, false);
  assert.ok(paths(result).includes("health.status"));
});

test("invalid observedAt timestamps fail", () => {
  for (const observedAt of [
    "not-a-date",
    "",
    "2026-13-45T99:99:99Z",
    123,
    null,
    "2026-10-18",
  ]) {
    const body = { ...validIngestionBody(), observedAt };
    const result = validateObservationIngestion(body);
    assert.equal(result.valid, false, `observedAt=${String(observedAt)}`);
    assert.ok(paths(result).includes("observedAt"));
  }
});

test("ISO date-only string without time fails", () => {
  const body = { ...validIngestionBody(), observedAt: "2026-10-18" };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, false);
  assert.ok(paths(result).includes("observedAt"));
});

test("malformed nested structures fail", () => {
  const cases: Record<string, unknown>[] = [
    { ...validIngestionBody(), application: "not-an-object" },
    { ...validIngestionBody(), runtime: 3 },
    { ...validIngestionBody(), resources: [] },
    { ...validIngestionBody(), health: "ok" },
    { ...validIngestionBody(), environment: "prod" },
    { ...validIngestionBody(), deployment: 1 },
    {
      ...validIngestionBody(),
      application: { image: "forge-api:v1", port: 70000 },
    },
    {
      ...validIngestionBody(),
      runtime: { replicas: -1 },
    },
    {
      ...validIngestionBody(),
      environment: { REPLICA_COUNT: 3 },
    },
  ];
  for (const body of cases) {
    const result = validateObservationIngestion(body);
    assert.equal(result.valid, false, JSON.stringify(body));
    assert.ok(result.errors.length > 0);
  }
});

test("projectId in the body is ignored — path parameter wins", () => {
  const body = { ...validIngestionBody(), projectId: "prj_ignored" };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, true);
  assert.ok(result.observation);
  assert.equal(result.observation.projectId, "");
});

test("non-object input is rejected", () => {
  assert.equal(validateObservationIngestion("not-an-observation").valid, false);
  assert.equal(validateObservationIngestion(null).valid, false);
  assert.equal(
    validateObservationIngestion([validIngestionBody()]).valid,
    false
  );
  assert.equal(validateObservationIngestion(42).valid, false);
});

test("multiple validation errors are all reported", () => {
  const body = {
    observationId: "",
    status: "mystery",
    runtime: { replicas: -2 },
    observedAt: "bad-date",
  };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, false);
  const seen = paths(result);
  assert.ok(seen.includes("observationId"));
  assert.ok(seen.includes("status"));
  assert.ok(seen.includes("runtime.replicas"));
  assert.ok(seen.includes("observedAt"));
  for (const error of result.errors) {
    assert.ok(error.path.length > 0);
    assert.ok(error.message.length > 0);
  }
});

test("unknown observation values (nulls) pass — unknown is not absence", () => {
  const body = {
    ...validIngestionBody(),
    status: "unknown",
    application: { image: null, port: null },
    runtime: { replicas: null },
    resources: { cpu: null, memory: null },
    health: { status: "unknown" },
  };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, true);
  assert.ok(result.observation);
  assert.equal(result.observation.application.image, null);
  assert.equal(result.observation.application.port, null);
  assert.equal(result.observation.runtime.replicas, null);
  assert.equal(result.observation.resources.cpu, null);
  assert.equal(result.observation.resources.memory, null);
  assert.equal(result.observation.health.status, "unknown");
});

test("observed zero replicas is valid and distinct from unknown", () => {
  const body = {
    ...validIngestionBody(),
    status: "stopped",
    runtime: { replicas: 0 },
    health: { status: "unknown" },
  };
  const result = validateObservationIngestion(body);
  assert.equal(result.valid, true);
  assert.ok(result.observation);
  assert.equal(result.observation.runtime.replicas, 0);
  assert.equal(result.observation.status, "stopped");
});
