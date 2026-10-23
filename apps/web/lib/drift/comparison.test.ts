import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type { DesiredState } from "../../types/desired-state.ts";
import { DriftComparisonError, compareDesiredAndActual } from "./comparison.ts";

function buildDesired(
  overrides: Partial<DesiredState> = {}
): DesiredState {
  return {
    desiredStateId: "ds_w81_001",
    projectId: "prj_w81_sample",
    version: 1,
    createdAt: new Date("2026-10-19T09:00:00Z"),
    updatedAt: new Date("2026-10-19T09:00:00Z"),
    applications: { image: "forge-api:v2", port: 8080, version: "2.0.0" },
    runtime: { replicas: 3 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 2 },
    health: { path: "/health" },
    ...overrides,
  };
}

function buildObservation(
  overrides: Partial<ActualStateObservation> = {}
): ActualStateObservation {
  return {
    observationId: "obs_w81_001",
    projectId: "prj_w81_sample",
    workloadId: "default",
    source: "test-harness",
    observedAt: new Date("2026-10-19T10:00:00Z"),
    status: "running",
    application: { image: "forge-api:v2", port: 8080, version: "2.0.0" },
    runtime: { replicas: 3 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 2 },
    health: { status: "healthy" },
    ...overrides,
  };
}

test("identical declaration and observation compare as a match", () => {
  const result = compareDesiredAndActual(buildDesired(), buildObservation());

  assert.equal(result.outcome, "match");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unknownProperties, []);
  assert.equal(result.comparedProperties.length, 9);
  assert.equal(result.projectId, "prj_w81_sample");
  assert.equal(result.workloadId, "default");
});

test("a differing property yields a drift outcome with a finding", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: "forge-api:v3", port: 8080, version: "2.0.0" },
    })
  );

  assert.equal(result.outcome, "drift");
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.property, "application.image");
  assert.equal(finding.category, "changed");
  assert.equal(finding.desiredValue, "forge-api:v2");
  assert.equal(finding.observedValue, "forge-api:v3");
  assert.ok(finding.explanation.includes('"forge-api:v2"'));
  assert.ok(finding.explanation.includes('"forge-api:v3"'));
});

test("an observation with only unknown values yields insufficient-data", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      status: "unknown",
      application: { image: null, port: null },
      runtime: { replicas: null },
      resources: { cpu: null, memory: null },
      environment: undefined,
      deployment: undefined,
      health: { status: "unknown" },
    })
  );

  assert.equal(result.outcome, "insufficient-data");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.comparedProperties, []);
  assert.equal(result.unknownProperties.length, 9);
});

test("unknown properties are disclosed alongside a match", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: null, port: 8080, version: "2.0.0" },
    })
  );

  assert.equal(result.outcome, "match");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unknownProperties, ["application.image"]);
  assert.equal(result.comparedProperties.length, 8);
});

test("a null observed replica count is unknown, never classified as missing", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ runtime: { replicas: null } })
  );

  assert.equal(result.outcome, "match");
  assert.deepEqual(result.findings, []);
  assert.ok(result.unknownProperties.includes("runtime.replicas"));
  assert.ok(!result.comparedProperties.includes("runtime.replicas"));
});

test("comparison rejects an observation from a different project", () => {
  assert.throws(
    () =>
      compareDesiredAndActual(
        buildDesired(),
        buildObservation({ projectId: "prj_other" })
      ),
    (error: unknown) => {
      assert.ok(error instanceof DriftComparisonError);
      assert.ok(error.message.includes("prj_w81_sample"));
      assert.ok(error.message.includes("prj_other"));
      return true;
    }
  );
});

test("equivalent inputs produce equivalent results", () => {
  const first = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      runtime: { replicas: 2 },
      health: { status: "unhealthy" },
    })
  );
  const second = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      runtime: { replicas: 2 },
      health: { status: "unhealthy" },
    })
  );

  assert.deepEqual(first, second);
});

test("the comparison does not mutate its inputs", () => {
  const desired = buildDesired();
  const observation = buildObservation();
  const desiredBefore = structuredClone(desired);
  const observationBefore = structuredClone(observation);

  compareDesiredAndActual(desired, observation);

  assert.deepEqual(desired, desiredBefore);
  assert.deepEqual(observation, observationBefore);
});

test("missing category: fewer observed replicas than declared", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ runtime: { replicas: 2 } })
  );

  assert.equal(result.outcome, "drift");
  const finding = result.findings[0];
  assert.equal(finding.property, "runtime.replicas");
  assert.equal(finding.category, "missing");
  assert.equal(finding.desiredValue, 3);
  assert.equal(finding.observedValue, 2);
  assert.ok(finding.explanation.includes("3 replica(s)"));
  assert.ok(finding.explanation.includes("2 observed"));
});

test("extra category: more observed replicas than declared", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ runtime: { replicas: 4 } })
  );

  assert.equal(result.outcome, "drift");
  const finding = result.findings[0];
  assert.equal(finding.property, "runtime.replicas");
  assert.equal(finding.category, "extra");
  assert.equal(finding.desiredValue, 3);
  assert.equal(finding.observedValue, 4);
});

test("an explicitly observed zero replica count is missing, not unknown", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ runtime: { replicas: 0 }, status: "stopped" })
  );

  assert.equal(result.outcome, "drift");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, "missing");
  assert.equal(result.findings[0].observedValue, 0);
  assert.ok(!result.unknownProperties.includes("runtime.replicas"));
});

test("unhealthy category: observed health status violates the declaration", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ health: { status: "unhealthy" } })
  );

  assert.equal(result.outcome, "drift");
  const finding = result.findings[0];
  assert.equal(finding.property, "health.status");
  assert.equal(finding.category, "unhealthy");
  assert.equal(finding.observedValue, "unhealthy");
  assert.ok(finding.explanation.includes('"/health"'));
});

test("configuration mismatch category: observed port differs", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: "forge-api:v2", port: 3000, version: "2.0.0" },
    })
  );

  assert.equal(result.outcome, "drift");
  const finding = result.findings[0];
  assert.equal(finding.property, "application.port");
  assert.equal(finding.category, "configuration-mismatch");
  assert.equal(finding.desiredValue, 8080);
  assert.equal(finding.observedValue, 3000);
});

test("configuration mismatch covers resources and environment values", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      resources: { cpu: "500m", memory: "512Mi" },
      environment: { NODE_ENV: "staging" },
    })
  );

  assert.equal(result.outcome, "drift");
  assert.equal(result.findings.length, 3);
  const categories = result.findings.map((f) => f.category);
  assert.deepEqual(
    categories,
    Array(3).fill("configuration-mismatch")
  );
  const properties = result.findings.map((f) => f.property);
  assert.deepEqual(properties, [
    "resources.cpu",
    "resources.memory",
    "environment",
  ]);
});

test("version mismatch category: deployment version differs", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ deployment: { version: 1 } })
  );

  assert.equal(result.outcome, "drift");
  const finding = result.findings[0];
  assert.equal(finding.property, "deployment.version");
  assert.equal(finding.category, "version-mismatch");
  assert.equal(finding.desiredValue, 2);
  assert.equal(finding.observedValue, 1);
});

test("version mismatch category: application version differs", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: "forge-api:v2", port: 8080, version: "1.0.0" },
    })
  );

  assert.equal(result.outcome, "drift");
  const finding = result.findings[0];
  assert.equal(finding.property, "application.version");
  assert.equal(finding.category, "version-mismatch");
  assert.equal(finding.desiredValue, "2.0.0");
  assert.equal(finding.observedValue, "1.0.0");
});

test("a single comparison can report several categories at once", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: "forge-api:v3", port: 3000 },
      runtime: { replicas: 1 },
      health: { status: "unhealthy" },
    })
  );

  assert.equal(result.outcome, "drift");
  const categories = [...new Set(result.findings.map((f) => f.category))].sort();
  assert.deepEqual(categories, [
    "changed",
    "configuration-mismatch",
    "missing",
    "unhealthy",
  ]);
});

test("unknown observed values never produce any drift category", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      runtime: { replicas: null },
      resources: { cpu: null, memory: null },
      health: { status: "unknown" },
    })
  );

  assert.deepEqual(result.findings, []);
  assert.equal(result.outcome, "match");
  assert.deepEqual(
    [...result.unknownProperties].sort(),
    ["health.status", "resources.cpu", "resources.memory", "runtime.replicas"]
  );
});

test("undeclared optional sections are not compared against observed extras", () => {
  const result = compareDesiredAndActual(
    buildDesired({
      applications: { image: "forge-api:v2", port: 8080 },
      environment: undefined,
      deployment: undefined,
    }),
    buildObservation()
  );

  assert.equal(result.outcome, "match");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unknownProperties, []);
  assert.deepEqual(result.comparedProperties, [
    "application.image",
    "application.port",
    "runtime.replicas",
    "resources.cpu",
    "resources.memory",
    "health.status",
  ]);
});

test("undeclared environment keys in the observation are not extra", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      environment: { NODE_ENV: "production", UNDECLARED_FLAG: "on" },
    })
  );

  assert.equal(result.outcome, "match");
  assert.deepEqual(result.findings, []);
  assert.ok(result.comparedProperties.includes("environment"));
});

test("an unobserved declared environment key is unknown, not a mismatch", () => {
  const result = compareDesiredAndActual(
    buildDesired({
      environment: { NODE_ENV: "production", LOG_LEVEL: "info" },
    }),
    buildObservation({ environment: { NODE_ENV: "production" } })
  );

  assert.equal(result.outcome, "match");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unknownProperties, ["environment"]);
  assert.ok(!result.comparedProperties.includes("environment"));
});

test("an unobserved declared deployment version is unknown, not a mismatch", () => {
  const omitted = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ deployment: undefined })
  );
  assert.deepEqual(omitted.findings, []);
  assert.deepEqual(omitted.unknownProperties, ["deployment.version"]);

  const nullVersion = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ deployment: { version: null } })
  );
  assert.deepEqual(nullVersion.findings, []);
  assert.deepEqual(nullVersion.unknownProperties, ["deployment.version"]);
  assert.equal(nullVersion.outcome, "match");
});

test("an unreported declared application version is unknown, not a mismatch", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ application: { image: "forge-api:v2", port: 8080 } })
  );

  assert.equal(result.outcome, "match");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unknownProperties, ["application.version"]);
});

test("comparison refuses unrelated project identities before classifying", () => {
  assert.throws(
    () =>
      compareDesiredAndActual(
        buildDesired(),
        buildObservation({ projectId: "prj_unrelated" })
      ),
    DriftComparisonError
  );

  assert.throws(
    () =>
      compareDesiredAndActual(
        buildDesired({ projectId: "prj_also_unrelated" }),
        buildObservation()
      ),
    DriftComparisonError
  );
});

test("drift results expose a documented structure without internal details", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({ runtime: { replicas: 1 } })
  );

  assert.deepEqual(Object.keys(result).sort(), [
    "comparedProperties",
    "findings",
    "outcome",
    "projectId",
    "unknownProperties",
    "workloadId",
  ]);
  const finding = result.findings[0];
  assert.deepEqual(Object.keys(finding).sort(), [
    "category",
    "desiredValue",
    "explanation",
    "observedValue",
    "property",
  ]);
  assert.ok(!("observationId" in result));
  assert.ok(!("desiredStateId" in result));
  assert.ok(!("observedAt" in result));
});

test("findings and unknowns follow a fixed deterministic property order", () => {
  const result = compareDesiredAndActual(
    buildDesired({
      environment: { NODE_ENV: "production", LOG_LEVEL: "info" },
    }),
    buildObservation({
      application: { image: "forge-api:v9", port: 9999 },
      runtime: { replicas: 1 },
      resources: { cpu: "1", memory: "1Gi" },
      environment: { NODE_ENV: "staging" },
      deployment: { version: null },
      health: { status: "unknown" },
    })
  );

  assert.equal(result.outcome, "drift");
  assert.deepEqual(
    result.findings.map((f) => f.property),
    [
      "application.image",
      "application.port",
      "runtime.replicas",
      "resources.cpu",
      "resources.memory",
      "environment",
    ]
  );
  assert.deepEqual(result.unknownProperties, [
    "application.version",
    "deployment.version",
    "health.status",
  ]);
  assert.deepEqual(result.comparedProperties, [
    "application.image",
    "application.port",
    "runtime.replicas",
    "resources.cpu",
    "resources.memory",
    "environment",
  ]);
});

test("every finding carries a property-specific explanation", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: "forge-api:v1", port: 3000, version: "1.0.0" },
      runtime: { replicas: 1 },
      resources: { cpu: "1", memory: "1Gi" },
      environment: { NODE_ENV: "staging" },
      deployment: { version: 1 },
      health: { status: "unhealthy" },
    })
  );

  assert.equal(result.findings.length, 9);
  for (const finding of result.findings) {
    assert.ok(
      finding.explanation.length > 0,
      `explanation missing for ${finding.property}`
    );
    assert.ok(
      finding.explanation.endsWith("."),
      `explanation for ${finding.property} should be a sentence`
    );
    assert.ok(
      ["missing", "extra", "changed", "unhealthy", "configuration-mismatch", "version-mismatch"].includes(
        finding.category
      )
    );
  }
});

test("environment findings disclose keys without exposing values", () => {
  const result = compareDesiredAndActual(
    buildDesired({ environment: { API_TOKEN: "declared-secret-value" } }),
    buildObservation({ environment: { API_TOKEN: "observed-secret-value" } })
  );

  assert.equal(result.outcome, "drift");
  const finding = result.findings.find(
    (f) => f.property === "environment"
  );
  assert.ok(finding);
  assert.equal(finding.category, "configuration-mismatch");
  assert.ok(finding.explanation.includes("API_TOKEN"));
  assert.ok(!("desiredValue" in finding));
  assert.ok(!("observedValue" in finding));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("declared-secret-value"));
  assert.ok(!serialized.includes("observed-secret-value"));
});

test("confirmed differences and unknown data are reported separately", () => {
  const result = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: "forge-api:v1", port: 8080, version: "2.0.0" },
      runtime: { replicas: null },
    })
  );

  assert.equal(result.outcome, "drift");
  assert.deepEqual(
    result.findings.map((f) => f.property),
    ["application.image"]
  );
  assert.deepEqual(result.unknownProperties, ["runtime.replicas"]);
  assert.ok(result.comparedProperties.includes("application.image"));
  assert.ok(!result.comparedProperties.includes("runtime.replicas"));
  for (const finding of result.findings) {
    assert.ok(result.comparedProperties.includes(finding.property));
  }
});

test("match with disclosed unknowns is distinct from insufficient-data", () => {
  const partial = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: null, port: 8080, version: "2.0.0" },
    })
  );
  assert.equal(partial.outcome, "match");
  assert.ok(partial.unknownProperties.length > 0);
  assert.ok(partial.comparedProperties.length > 0);

  const nothing = compareDesiredAndActual(
    buildDesired(),
    buildObservation({
      application: { image: null, port: null },
      runtime: { replicas: null },
      resources: { cpu: null, memory: null },
      environment: undefined,
      deployment: undefined,
      health: { status: "unknown" },
    })
  );
  assert.equal(nothing.outcome, "insufficient-data");
  assert.deepEqual(nothing.findings, []);
  assert.deepEqual(nothing.comparedProperties, []);
});
