import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type { DesiredState } from "../../types/desired-state.ts";
import type { DriftComparisonResult } from "../../types/drift.ts";
import { prisma } from "../prisma.ts";
import { deleteObservationsForProject } from "../persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../persistence/desired-state.ts";
import {
  createDesiredState,
  getCurrentDesiredState,
  updateDesiredState,
} from "./desired-state.ts";
import { getLatestObservation, ingestObservation } from "./actual-state.ts";
import {
  compareProjectState,
  type ProjectDriftComparison,
} from "./drift.ts";

const KEEP = process.env.W85_KEEP === "1";
const flowProjectName = "w85-drift-flow";
const otherProjectName = "w85-drift-other";

function buildDesiredState(
  projectId: string,
  desiredStateId: string
): DesiredState {
  return {
    desiredStateId,
    projectId,
    version: 1,
    createdAt: new Date("2026-10-19T08:00:00Z"),
    updatedAt: new Date("2026-10-19T08:00:00Z"),
    applications: { image: "forge-api:v1", port: 8080, version: "1.0.0" },
    runtime: { replicas: 3 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
    health: { path: "/health" },
  };
}

function buildObservation(
  observationId: string,
  projectId: string,
  workloadId: string,
  overrides: Partial<ActualStateObservation> = {}
): ActualStateObservation {
  return {
    observationId,
    projectId,
    workloadId,
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

function assertCompared(
  result: ProjectDriftComparison
): asserts result is Extract<ProjectDriftComparison, { status: "compared" }> {
  assert.equal(result.status, "compared");
}

async function ensureProject(name: string): Promise<string> {
  const existing = await prisma.project.findFirst({ where: { name } });
  if (existing) {
    return existing.id;
  }
  const created = await prisma.project.create({
    data: { name, status: "stopped", deployments: 0 },
  });
  return created.id;
}

let flowProjectId: string;
let otherProjectId: string;

before(async () => {
  flowProjectId = await ensureProject(flowProjectName);
  otherProjectId = await ensureProject(otherProjectName);

  if (!KEEP) {
    for (const projectId of [flowProjectId, otherProjectId]) {
      await deleteObservationsForProject(projectId);
      await deleteDesiredStatesForProject(projectId);
    }
  }

  await createDesiredState(buildDesiredState(flowProjectId, "ds_w85_flow_v1"));
  await updateDesiredState(flowProjectId, {
    ...buildDesiredState(flowProjectId, "ds_w85_flow_v2"),
    applications: { image: "forge-api:v2", port: 8080, version: "2.0.0" },
    deployment: { version: 2 },
  });

  await createDesiredState(buildDesiredState(otherProjectId, "ds_w85_other_v1"));
  await ingestObservation(
    buildObservation("obs_w85_other_001", otherProjectId, "default", {
      application: { image: "forge-api:v1", port: 8080, version: "1.0.0" },
      deployment: { version: 1 },
    })
  );
});

after(async () => {
  try {
    if (!KEEP) {
      for (const projectId of [flowProjectId, otherProjectId]) {
        await deleteObservationsForProject(projectId);
        await deleteDesiredStatesForProject(projectId);
      }
      await prisma.project.deleteMany({
        where: { name: { in: [flowProjectName, otherProjectName] } },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

async function compareAgainstObservation(
  workloadId: string,
  overrides: Partial<ActualStateObservation> = {}
): Promise<DriftComparisonResult> {
  await ingestObservation(
    buildObservation(`obs_w85_${workloadId}`, flowProjectId, workloadId, overrides)
  );
  const result = await compareProjectState(flowProjectId, workloadId);
  assertCompared(result);
  return result.comparison;
}

test("flow: a matching observation and the current Desired State version produce a match", async () => {
  const result = await compareProjectState(flowProjectId, "flow-match");
  assert.equal(result.status, "no-observation");

  const comparison = await compareAgainstObservation("flow-match");
  assert.equal(comparison.outcome, "match");
  assert.deepEqual(comparison.findings, []);
  assert.equal(comparison.projectId, flowProjectId);

  const served = await compareProjectState(flowProjectId, "flow-match");
  assertCompared(served);
  assert.deepEqual(served.desiredState, {
    desiredStateId: "ds_w85_flow_v2",
    version: 2,
  });
  assert.equal(served.observation.observationId, "obs_w85_flow-match");
});

test("flow: a declared-but-unobserved workload is reported as no observation, never as drift", async () => {
  const result = await compareProjectState(flowProjectId, "flow-never-reported");

  assert.equal(result.status, "no-observation");
  assert.ok(!("comparison" in result));
  assert.deepEqual(result.desiredState, {
    desiredStateId: "ds_w85_flow_v2",
    version: 2,
  });
});

test("flow: a stale observation is still compared, and its age is disclosed instead of hidden", async () => {
  const staleAt = new Date("2026-09-01T06:30:00.000Z");
  const comparison = await compareAgainstObservation("flow-stale", {
    observedAt: staleAt,
  });

  assert.equal(comparison.outcome, "match");
  assert.deepEqual(comparison.findings, []);

  const served = await compareProjectState(flowProjectId, "flow-stale");
  assertCompared(served);
  assert.equal(
    served.observation.observedAt.toISOString(),
    "2026-09-01T06:30:00.000Z"
  );
  assert.ok(
    served.observation.observedAt.getTime() < Date.now() - 24 * 60 * 60 * 1000,
    "the observation is genuinely old"
  );
});

test("flow: fewer observed replicas than declared classify as missing", async () => {
  const comparison = await compareAgainstObservation("flow-missing", {
    runtime: { replicas: 2 },
  });

  assert.equal(comparison.outcome, "drift");
  assert.equal(comparison.findings.length, 1);
  assert.equal(comparison.findings[0].property, "runtime.replicas");
  assert.equal(comparison.findings[0].category, "missing");
  assert.equal(comparison.findings[0].desiredValue, 3);
  assert.equal(comparison.findings[0].observedValue, 2);
});

test("flow: more observed replicas than declared classify as extra", async () => {
  const comparison = await compareAgainstObservation("flow-extra", {
    runtime: { replicas: 5 },
  });

  assert.equal(comparison.outcome, "drift");
  assert.equal(comparison.findings.length, 1);
  assert.equal(comparison.findings[0].property, "runtime.replicas");
  assert.equal(comparison.findings[0].category, "extra");
  assert.equal(comparison.findings[0].desiredValue, 3);
  assert.equal(comparison.findings[0].observedValue, 5);
});

test("flow: a differing comparable property classifies as changed", async () => {
  const comparison = await compareAgainstObservation("flow-changed", {
    application: { image: "forge-api:v1", port: 8080, version: "2.0.0" },
  });

  assert.equal(comparison.outcome, "drift");
  const finding = comparison.findings.find(
    (f) => f.property === "application.image"
  );
  assert.ok(finding);
  assert.equal(finding.category, "changed");
  assert.equal(finding.desiredValue, "forge-api:v2");
  assert.equal(finding.observedValue, "forge-api:v1");
});

test("flow: an observed unhealthy status classifies as unhealthy", async () => {
  const comparison = await compareAgainstObservation("flow-unhealthy", {
    health: { status: "unhealthy" },
  });

  assert.equal(comparison.outcome, "drift");
  const finding = comparison.findings.find(
    (f) => f.property === "health.status"
  );
  assert.ok(finding);
  assert.equal(finding.category, "unhealthy");
  assert.equal(finding.observedValue, "unhealthy");
});

test("flow: differing comparable configuration classifies as configuration mismatch", async () => {
  const comparison = await compareAgainstObservation("flow-config", {
    application: { image: "forge-api:v2", port: 3000, version: "2.0.0" },
    resources: { cpu: "500m", memory: "256Mi" },
    environment: { NODE_ENV: "staging" },
  });

  assert.equal(comparison.outcome, "drift");
  const categories = comparison.findings.map((f) => f.category);
  assert.deepEqual(categories, [
    "configuration-mismatch",
    "configuration-mismatch",
    "configuration-mismatch",
  ]);
  assert.deepEqual(comparison.findings.map((f) => f.property), [
    "application.port",
    "resources.cpu",
    "environment",
  ]);
});

test("flow: differing desired and observed versions classify as version mismatch", async () => {
  const comparison = await compareAgainstObservation("flow-version", {
    application: { image: "forge-api:v2", port: 8080, version: "1.0.0" },
    deployment: { version: 1 },
  });

  assert.equal(comparison.outcome, "drift");
  assert.deepEqual(comparison.findings.map((f) => f.property), [
    "application.version",
    "deployment.version",
  ]);
  for (const finding of comparison.findings) {
    assert.equal(finding.category, "version-mismatch");
  }
  assert.equal(comparison.findings[0].desiredValue, "2.0.0");
  assert.equal(comparison.findings[0].observedValue, "1.0.0");
});

test("flow: comparison never mutates the stored Desired State or observation", async () => {
  await ingestObservation(
    buildObservation("obs_w85_flow-immutable", flowProjectId, "flow-immutable")
  );

  const desiredBefore = await getCurrentDesiredState(flowProjectId);
  const observationBefore = await getLatestObservation(
    flowProjectId,
    "flow-immutable"
  );
  assert.ok(desiredBefore);
  assert.ok(observationBefore);

  await compareProjectState(flowProjectId, "flow-immutable");

  const desiredAfter = await getCurrentDesiredState(flowProjectId);
  const observationAfter = await getLatestObservation(
    flowProjectId,
    "flow-immutable"
  );

  assert.deepEqual(desiredAfter, desiredBefore);
  assert.deepEqual(observationAfter, observationBefore);
});

test("flow: repeated comparisons over unchanged inputs return stable results", async () => {
  await ingestObservation(
    buildObservation("obs_w85_flow-stable", flowProjectId, "flow-stable", {
      runtime: { replicas: 1 },
      health: { status: "unhealthy" },
    })
  );

  const first = await compareProjectState(flowProjectId, "flow-stable");
  const second = await compareProjectState(flowProjectId, "flow-stable");

  assert.deepEqual(second, first);
  assertCompared(first);
  assert.equal(first.comparison.outcome, "drift");
  assert.deepEqual(
    first.comparison.findings.map((f) => f.category),
    ["missing", "unhealthy"]
  );
});

test("flow: unrelated projects are never compared against each other", async () => {
  const isolated = await compareProjectState(otherProjectId, "default");
  assertCompared(isolated);
  assert.equal(isolated.comparison.outcome, "match");
  assert.equal(isolated.comparison.projectId, otherProjectId);
  assert.deepEqual(isolated.desiredState, {
    desiredStateId: "ds_w85_other_v1",
    version: 1,
  });

  const crossRead = await compareProjectState(otherProjectId, "flow-match");
  assert.equal(crossRead.status, "no-observation");

  const flowView = await compareProjectState(flowProjectId, "default");
  assert.equal(flowView.status, "no-observation");
});

test("flow: the current Desired State version drives the comparison, not older versions", async () => {
  const comparison = await compareAgainstObservation("flow-old-declaration", {
    application: { image: "forge-api:v1", port: 8080, version: "1.0.0" },
    deployment: { version: 1 },
  });

  assert.equal(comparison.outcome, "drift");
  const imageFinding = comparison.findings.find(
    (f) => f.property === "application.image"
  );
  assert.ok(imageFinding);
  assert.equal(imageFinding.desiredValue, "forge-api:v2");
  assert.equal(imageFinding.observedValue, "forge-api:v1");
});
