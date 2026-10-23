import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type { DesiredState } from "../../types/desired-state.ts";
import { prisma } from "../prisma.ts";
import { deleteObservationsForProject } from "../persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../persistence/desired-state.ts";
import { createDesiredState, updateDesiredState } from "./desired-state.ts";
import { ingestObservation } from "./actual-state.ts";
import {
  compareProjectState,
  DriftServiceError,
  type ProjectDriftComparison,
} from "./drift.ts";

const KEEP = process.env.W84_KEEP === "1";
const mainProjectName = "w84-drift-main";
const emptyProjectName = "w84-drift-nodeclared";
const otherProjectName = "w84-drift-other";

function buildDesiredState(
  projectId: string,
  desiredStateId = "ds_w84_main_v1"
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
    application: { image: "forge-api:v1", port: 8080, version: "1.0.0" },
    runtime: { replicas: 3 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
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

let mainProjectId: string;
let emptyProjectId: string;
let otherProjectId: string;

before(async () => {
  mainProjectId = await ensureProject(mainProjectName);
  emptyProjectId = await ensureProject(emptyProjectName);
  otherProjectId = await ensureProject(otherProjectName);

  if (!KEEP) {
    for (const projectId of [mainProjectId, emptyProjectId, otherProjectId]) {
      await deleteObservationsForProject(projectId);
      await deleteDesiredStatesForProject(projectId);
    }
  }

  await createDesiredState(buildDesiredState(mainProjectId));
  await createDesiredState(
    buildDesiredState(otherProjectId, "ds_w84_other_v1")
  );

  await ingestObservation(
    buildObservation("obs_w84_empty_001", emptyProjectId, "default")
  );
  await ingestObservation(
    buildObservation("obs_w84_other_001", otherProjectId, "default", {
      application: { image: "forge-api:other", port: 8080, version: "1.0.0" },
    })
  );
});

after(async () => {
  try {
    if (!KEEP) {
      for (const projectId of [mainProjectId, emptyProjectId, otherProjectId]) {
        await deleteObservationsForProject(projectId);
        await deleteDesiredStatesForProject(projectId);
      }
      await prisma.project.deleteMany({
        where: {
          name: { in: [mainProjectName, emptyProjectName, otherProjectName] },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("missing Desired State is reported before observation lookup", async () => {
  const result = await compareProjectState(emptyProjectId, "default");

  assert.equal(result.status, "no-desired-state");
  assert.deepEqual(Object.keys(result).sort(), [
    "projectId",
    "status",
    "workloadId",
  ]);
  assert.equal(result.projectId, emptyProjectId);
  assert.equal(result.workloadId, "default");
});

test("missing observation reports the current Desired State summary", async () => {
  const result = await compareProjectState(mainProjectId, "w84-none");

  assert.equal(result.status, "no-observation");
  assert.equal(result.projectId, mainProjectId);
  assert.equal(result.workloadId, "w84-none");
  assert.deepEqual(result.desiredState, {
    desiredStateId: "ds_w84_main_v1",
    version: 1,
  });
  assert.ok(!("observation" in result));
  assert.ok(!("comparison" in result));
});

test("the default workload id is used when omitted", async () => {
  const result = await compareProjectState(mainProjectId);

  assert.equal(result.status, "no-observation");
  assert.equal(result.workloadId, "default");
});

test("a matching observation compares as a confirmed match", async () => {
  await ingestObservation(
    buildObservation("obs_w84_match_001", mainProjectId, "w84-match")
  );

  const result = await compareProjectState(mainProjectId, "w84-match");
  assertCompared(result);

  assert.deepEqual(Object.keys(result).sort(), [
    "comparison",
    "desiredState",
    "observation",
    "projectId",
    "status",
    "workloadId",
  ]);
  assert.deepEqual(result.desiredState, {
    desiredStateId: "ds_w84_main_v1",
    version: 1,
  });
  assert.deepEqual(result.observation, {
    observationId: "obs_w84_match_001",
    workloadId: "w84-match",
    observedAt: new Date("2026-10-19T10:00:00Z"),
    source: "test-harness",
    status: "running",
  });
  assert.equal(result.comparison.outcome, "match");
  assert.deepEqual(result.comparison.findings, []);
  assert.equal(result.comparison.projectId, mainProjectId);
  assert.equal(result.comparison.workloadId, "w84-match");
});

test("a differing observation reports confirmed drift", async () => {
  await ingestObservation(
    buildObservation("obs_w84_drift_001", mainProjectId, "w84-drift", {
      observedAt: new Date("2026-10-19T10:05:00Z"),
      application: { image: "forge-api:v0", port: 8080, version: "1.0.0" },
      runtime: { replicas: 1 },
    })
  );

  const result = await compareProjectState(mainProjectId, "w84-drift");
  assertCompared(result);

  assert.equal(result.comparison.outcome, "drift");
  assert.equal(result.comparison.findings.length, 2);
  const categories = result.comparison.findings
    .map((f) => f.category)
    .sort();
  assert.deepEqual(categories, ["changed", "missing"]);
  assert.equal(result.comparison.projectId, mainProjectId);
});

test("the latest observation by observedAt is compared, not the newest ingested", async () => {
  await ingestObservation(
    buildObservation("obs_w84_stale_a", mainProjectId, "w84-stale", {
      observedAt: new Date("2026-10-19T10:10:00Z"),
      application: { image: "forge-api:v0", port: 8080, version: "1.0.0" },
    })
  );
  await ingestObservation(
    buildObservation("obs_w84_stale_b", mainProjectId, "w84-stale", {
      observedAt: new Date("2026-10-19T12:00:00Z"),
    })
  );
  await ingestObservation(
    buildObservation("obs_w84_stale_c", mainProjectId, "w84-stale", {
      observedAt: new Date("2026-10-19T11:00:00Z"),
      application: { image: "forge-api:v9", port: 8080, version: "1.0.0" },
    })
  );

  const result = await compareProjectState(mainProjectId, "w84-stale");
  assertCompared(result);

  assert.equal(result.observation.observationId, "obs_w84_stale_b");
  assert.equal(
    result.observation.observedAt.toISOString(),
    "2026-10-19T12:00:00.000Z"
  );
  assert.equal(result.comparison.outcome, "match");
});

test("an all-unknown observation yields insufficient data, not drift", async () => {
  await ingestObservation(
    buildObservation("obs_w84_unknown_001", mainProjectId, "w84-unknown", {
      status: "unknown",
      application: { image: null, port: null },
      runtime: { replicas: null },
      resources: { cpu: null, memory: null },
      environment: undefined,
      deployment: undefined,
      health: { status: "unknown" },
    })
  );

  const result = await compareProjectState(mainProjectId, "w84-unknown");
  assertCompared(result);

  assert.equal(result.observation.status, "unknown");
  assert.equal(result.comparison.outcome, "insufficient-data");
  assert.deepEqual(result.comparison.findings, []);
  assert.deepEqual(result.comparison.comparedProperties, []);
});

test("observations from other projects are never compared", async () => {
  const invisible = await compareProjectState(mainProjectId, "default");
  assert.equal(invisible.status, "no-observation");

  const isolated = await compareProjectState(otherProjectId, "default");
  assertCompared(isolated);

  assert.equal(isolated.projectId, otherProjectId);
  assert.equal(isolated.comparison.projectId, otherProjectId);
  assert.equal(isolated.comparison.workloadId, "default");
  assert.equal(isolated.comparison.outcome, "drift");
  assert.equal(isolated.comparison.findings[0].observedValue, "forge-api:other");
});

test("invalid identifiers are rejected before any lookup", async () => {
  await assert.rejects(
    compareProjectState(""),
    (error: unknown) => {
      assert.ok(error instanceof DriftServiceError);
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.ok(error.message.includes("projectId"));
      return true;
    }
  );

  await assert.rejects(
    compareProjectState(mainProjectId, "   "),
    (error: unknown) => {
      assert.ok(error instanceof DriftServiceError);
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.ok(error.message.includes("workloadId"));
      return true;
    }
  );

  await assert.rejects(
    compareProjectState(null as unknown as string),
    DriftServiceError
  );
});

test("the current Desired State version is used, not a previous one", async () => {
  await updateDesiredState(mainProjectId, {
    ...buildDesiredState(mainProjectId, "ds_w84_main_v2"),
    applications: { image: "forge-api:v2", port: 8080, version: "2.0.0" },
    runtime: { replicas: 1 },
    deployment: { version: 2 },
  });

  await ingestObservation(
    buildObservation("obs_w84_v2_001", mainProjectId, "w84-v2", {
      observedAt: new Date("2026-10-19T13:00:00Z"),
      application: { image: "forge-api:v2", port: 8080, version: "2.0.0" },
      runtime: { replicas: 1 },
      deployment: { version: 2 },
    })
  );
  const matched = await compareProjectState(mainProjectId, "w84-v2");
  assertCompared(matched);
  assert.deepEqual(matched.desiredState, {
    desiredStateId: "ds_w84_main_v2",
    version: 2,
  });
  assert.equal(matched.comparison.outcome, "match");

  await ingestObservation(
    buildObservation("obs_w84_v1old_001", mainProjectId, "w84-v1old", {
      observedAt: new Date("2026-10-19T13:05:00Z"),
    })
  );
  const drifted = await compareProjectState(mainProjectId, "w84-v1old");
  assertCompared(drifted);
  assert.equal(drifted.desiredState.version, 2);
  assert.equal(drifted.comparison.outcome, "drift");
  const imageFinding = drifted.comparison.findings.find(
    (f) => f.property === "application.image"
  );
  assert.ok(imageFinding);
  assert.equal(imageFinding.desiredValue, "forge-api:v2");
  assert.equal(imageFinding.observedValue, "forge-api:v1");
});
