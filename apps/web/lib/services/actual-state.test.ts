import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import { prisma } from "../prisma.ts";
import {
  deleteObservationsForProject,
  InvalidProjectError,
} from "../persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../persistence/desired-state.ts";
import { createDesiredState } from "./desired-state.ts";
import {
  ActualStateConflictError,
  ActualStateServiceError,
  ActualStateValidationFailedError,
  ensureValidActualStateObservation,
  getLatestObservation,
  ingestObservation,
  listObservations,
  recordObservation,
} from "./actual-state.ts";

const KEEP = process.env.W73_KEEP === "1";
const actualProjectName = "w73-actual-service";

function buildObservation(
  overrides: Partial<ActualStateObservation> = {}
): ActualStateObservation {
  return {
    observationId: "obs_w73_001",
    projectId: "prj_w73_sample",
    workloadId: "default",
    source: "test-harness",
    observedAt: new Date("2026-10-17T10:00:00Z"),
    status: "running",
    application: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
    health: { status: "healthy" },
    ...overrides,
  };
}

let actualProjectId: string | undefined;

before(async () => {
  const existing = await prisma.project.findFirst({
    where: { name: actualProjectName },
  });
  actualProjectId =
    existing?.id ??
    (
      await prisma.project.create({
        data: {
          name: actualProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;
  if (!KEEP) {
    await deleteObservationsForProject(actualProjectId);
    await deleteDesiredStatesForProject(actualProjectId);
  }
});

after(async () => {
  try {
    if (!KEEP && actualProjectId) {
      await deleteObservationsForProject(actualProjectId);
      await deleteDesiredStatesForProject(actualProjectId);
      await prisma.project.deleteMany({
        where: { name: actualProjectName },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("validation gate accepts a valid observation", () => {
  assert.doesNotThrow(() =>
    ensureValidActualStateObservation(buildObservation())
  );
});

test("validation gate rejects invalid input with VALIDATION_FAILED", () => {
  assert.throws(
    () => ensureValidActualStateObservation({ observationId: "obs_x" }),
    (error: unknown) => {
      assert.ok(error instanceof ActualStateValidationFailedError);
      assert.ok(error instanceof ActualStateServiceError);
      assert.equal(
        (error as ActualStateValidationFailedError).code,
        "VALIDATION_FAILED"
      );
      const paths = error.validationErrors.map((e) => e.path);
      assert.ok(paths.includes("projectId"));
      assert.ok(paths.includes("observedAt"));
      assert.ok(paths.includes("application"));
      assert.ok(paths.includes("runtime"));
      assert.ok(paths.includes("resources"));
      assert.ok(paths.includes("health"));
      return true;
    }
  );
});

test("RECORD: valid observation is stored and returned as a domain object", async () => {
  assert.ok(actualProjectId);
  const input = buildObservation({
    observationId: "obs_w73_record_v1",
    projectId: actualProjectId,
  });

  const result = await recordObservation(input);

  assert.equal(result.observationId, "obs_w73_record_v1");
  assert.equal(result.projectId, actualProjectId);
  assert.equal(result.workloadId, "default");
  assert.equal(result.source, "test-harness");
  assert.equal(result.status, "running");
  assert.ok(result.observedAt instanceof Date);
  assert.deepEqual(result.application, { image: "forge-api:v1", port: 8080 });
  assert.deepEqual(result.runtime, { replicas: 2 });
  assert.deepEqual(result.resources, { cpu: "250m", memory: "256Mi" });
  assert.deepEqual(result.environment, { NODE_ENV: "production" });
  assert.deepEqual(result.deployment, { version: 1 });
  assert.deepEqual(result.health, { status: "healthy" });
});

test("RECORD: persistence boundary is used, not direct Prisma access in the service", async () => {
  assert.ok(actualProjectId);
  const stored = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w73_record_v1" },
  });
  assert.ok(stored);
  assert.equal(stored.projectId, actualProjectId);
  assert.equal(stored.status, "running");
  const data = stored.data as { runtime?: { replicas?: number } };
  assert.equal(data.runtime?.replicas, 2);
});

test("RECORD: unknown observed values round trip as null, not undefined", async () => {
  assert.ok(actualProjectId);
  const input = buildObservation({
    observationId: "obs_w73_unknown",
    projectId: actualProjectId,
    status: "unknown",
    application: { image: null, port: null },
    runtime: { replicas: null },
    resources: { cpu: null, memory: null },
    deployment: { version: null },
    health: { status: "unknown" },
  });
  delete input.environment;

  const result = await recordObservation(input);

  assert.equal(result.status, "unknown");
  assert.equal(result.application.image, null);
  assert.equal(result.application.port, null);
  assert.equal(result.runtime.replicas, null);
  assert.equal(result.resources.cpu, null);
  assert.equal(result.resources.memory, null);
  assert.equal(result.deployment?.version, null);
  assert.equal(result.health.status, "unknown");
  assert.ok(!("environment" in result));
});

test("RECORD: observed zero replicas is stored distinctly from unknown", async () => {
  assert.ok(actualProjectId);
  const result = await recordObservation(
    buildObservation({
      observationId: "obs_w73_zero",
      projectId: actualProjectId,
      status: "stopped",
      runtime: { replicas: 0 },
      health: { status: "unknown" },
    })
  );
  assert.equal(result.runtime.replicas, 0);
  assert.equal(result.status, "stopped");
});

test("RECORD: invalid observation is rejected before persistence", async () => {
  assert.ok(actualProjectId);
  const before = await prisma.actualStateObservation.count({
    where: { projectId: actualProjectId },
  });

  await assert.rejects(
    recordObservation(
      buildObservation({
        observationId: "obs_w73_invalid",
        projectId: actualProjectId,
        runtime: { replicas: -1 },
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof ActualStateValidationFailedError);
      assert.ok(
        error.validationErrors.some((e) => e.path === "runtime.replicas")
      );
      return true;
    }
  );

  const after = await prisma.actualStateObservation.count({
    where: { projectId: actualProjectId },
  });
  assert.equal(after, before);
});

test("RECORD: valid observation for unknown project surfaces InvalidProjectError", async () => {
  await assert.rejects(
    recordObservation(
      buildObservation({
        observationId: "obs_w73_orphan",
        projectId: "prj_w73_does_not_exist",
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidProjectError);
      assert.equal((error as InvalidProjectError).code, "INVALID_PROJECT");
      return true;
    }
  );
});

test("READ: latest observation is returned as a domain object", async () => {
  assert.ok(actualProjectId);
  const latest = await getLatestObservation(actualProjectId, "default");
  assert.ok(latest);
  assert.ok(latest.observedAt instanceof Date);
  const keys = Object.keys(latest).sort();
  assert.deepEqual(keys, [
    "application",
    "createdAt",
    "deployment",
    "environment",
    "health",
    "observationId",
    "observedAt",
    "projectId",
    "resources",
    "runtime",
    "source",
    "status",
    "workloadId",
  ]);
});

test("READ: missing observation resolves to null and empty history", async () => {
  assert.equal(
    await getLatestObservation("prj_w73_missing", "default"),
    null
  );
  assert.ok(actualProjectId);
  assert.deepEqual(await listObservations(actualProjectId, "never-deployed"), []);
});

test("LATEST: selection follows observedAt, not storage order", async () => {
  assert.ok(actualProjectId);
  const workloadId = "latest-check";

  await recordObservation(
    buildObservation({
      observationId: "obs_w73_latest_first",
      projectId: actualProjectId,
      workloadId,
      observedAt: new Date("2026-10-17T12:00:00Z"),
      application: { image: "forge-api:v1", port: 8080 },
    })
  );
  await recordObservation(
    buildObservation({
      observationId: "obs_w73_latest_second",
      projectId: actualProjectId,
      workloadId,
      observedAt: new Date("2026-10-17T11:00:00Z"),
      application: { image: "forge-api:v0", port: 8080 },
    })
  );
  await recordObservation(
    buildObservation({
      observationId: "obs_w73_latest_third",
      projectId: actualProjectId,
      workloadId,
      observedAt: new Date("2026-10-17T13:00:00Z"),
      application: { image: "forge-api:v2", port: 8080 },
    })
  );

  const latest = await getLatestObservation(actualProjectId, workloadId);
  assert.ok(latest);
  assert.equal(latest.observationId, "obs_w73_latest_third");
  assert.equal(latest.observedAt.getTime(), Date.parse("2026-10-17T13:00:00Z"));
  assert.deepEqual(latest.application, { image: "forge-api:v2", port: 8080 });
});

test("HISTORY: list returns observations in observedAt order", async () => {
  assert.ok(actualProjectId);
  const history = await listObservations(actualProjectId, "latest-check");
  assert.deepEqual(
    history.map((o) => o.observationId),
    [
      "obs_w73_latest_second",
      "obs_w73_latest_first",
      "obs_w73_latest_third",
    ]
  );
  assert.ok(history.every((o) => o.projectId === actualProjectId));
  assert.ok(history.every((o) => o.workloadId === "latest-check"));
});

test("ISOLATION: workloads within a project keep separate latest/history", async () => {
  assert.ok(actualProjectId);
  await recordObservation(
    buildObservation({
      observationId: "obs_w73_worker_a",
      projectId: actualProjectId,
      workloadId: "worker-a",
      observedAt: new Date("2026-10-17T09:00:00Z"),
    })
  );

  const workerA = await getLatestObservation(actualProjectId, "worker-a");
  assert.ok(workerA);
  assert.equal(workerA.observationId, "obs_w73_worker_a");

  const defaultLatest = await getLatestObservation(actualProjectId, "default");
  assert.ok(defaultLatest);
  assert.notEqual(defaultLatest.observationId, "obs_w73_worker_a");

  const workerAHistory = await listObservations(actualProjectId, "worker-a");
  assert.equal(workerAHistory.length, 1);
});

test("SEPARATION: Actual State and Desired State records coexist independently", async () => {
  assert.ok(actualProjectId);

  await createDesiredState({
    desiredStateId: "ds_w73_separation_v1",
    projectId: actualProjectId,
    version: 1,
    createdAt: new Date("2026-10-17T00:00:00Z"),
    updatedAt: new Date("2026-10-17T00:00:00Z"),
    applications: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    health: { path: "/health" },
  });

  const desiredRows = await prisma.desiredState.count({
    where: { projectId: actualProjectId },
  });
  const observationRows = await prisma.actualStateObservation.count({
    where: { projectId: actualProjectId },
  });
  assert.equal(desiredRows, 1);
  assert.ok(observationRows >= 4);

  const latest = await getLatestObservation(actualProjectId, "default");
  assert.ok(latest);
  assert.equal(latest.observationId, "obs_w73_zero");

  const latestCheck = await getLatestObservation(actualProjectId, "latest-check");
  assert.ok(latestCheck);
  assert.equal(latestCheck.observationId, "obs_w73_latest_third");

  const desired = await prisma.desiredState.findUnique({
    where: {
      projectId_version: { projectId: actualProjectId, version: 1 },
    },
  });
  assert.ok(desired);
  assert.equal(desired.desiredStateId, "ds_w73_separation_v1");
});

test("INGEST: valid observation is stored and returned as a domain object", async () => {
  assert.ok(actualProjectId);
  const input = buildObservation({
    observationId: "obs_w77_ingest_v1",
    projectId: actualProjectId,
  });

  const result = await ingestObservation(input);

  assert.equal(result.observationId, "obs_w77_ingest_v1");
  assert.equal(result.projectId, actualProjectId);
  assert.equal(result.workloadId, "default");
  assert.equal(result.source, "test-harness");
  assert.equal(result.status, "running");
  assert.ok(result.observedAt instanceof Date);
  assert.deepEqual(result.application, { image: "forge-api:v1", port: 8080 });
  assert.deepEqual(result.runtime, { replicas: 2 });
  assert.deepEqual(result.resources, { cpu: "250m", memory: "256Mi" });
  assert.deepEqual(result.health, { status: "healthy" });
});

test("INGEST: duplicate observationId is rejected with CONFLICT", async () => {
  assert.ok(actualProjectId);
  const input = buildObservation({
    observationId: "obs_w77_ingest_v1",
    projectId: actualProjectId,
  });

  await assert.rejects(
    ingestObservation(input),
    (error: unknown) => {
      assert.ok(error instanceof ActualStateConflictError);
      assert.ok(error instanceof ActualStateServiceError);
      assert.equal(
        (error as ActualStateConflictError).code,
        "CONFLICT"
      );
      assert.ok(
        (error as ActualStateConflictError).message.includes(
          "obs_w77_ingest_v1"
        )
      );
      return true;
    }
  );

  const count = await prisma.actualStateObservation.count({
    where: { observationId: "obs_w77_ingest_v1" },
  });
  assert.equal(count, 1);
});

test("INGEST: invalid observation is rejected before persistence", async () => {
  assert.ok(actualProjectId);
  const before = await prisma.actualStateObservation.count({
    where: { projectId: actualProjectId },
  });

  await assert.rejects(
    ingestObservation(
      buildObservation({
        observationId: "obs_w77_invalid",
        projectId: actualProjectId,
        runtime: { replicas: -1 },
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof ActualStateValidationFailedError);
      return true;
    }
  );

  const after = await prisma.actualStateObservation.count({
    where: { projectId: actualProjectId },
  });
  assert.equal(after, before);
});

test("INGEST: missing Project surfaces InvalidProjectError", async () => {
  await assert.rejects(
    ingestObservation(
      buildObservation({
        observationId: "obs_w77_orphan",
        projectId: "prj_w77_does_not_exist",
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidProjectError);
      assert.equal((error as InvalidProjectError).code, "INVALID_PROJECT");
      return true;
    }
  );
});

test("INGEST: stale observation (older observedAt) is accepted and stored", async () => {
  assert.ok(actualProjectId);
  const workloadId = "stale-check";

  await ingestObservation(
    buildObservation({
      observationId: "obs_w77_stale_newer",
      projectId: actualProjectId,
      workloadId,
      observedAt: new Date("2026-10-18T14:00:00Z"),
      application: { image: "forge-api:v2", port: 8080 },
    })
  );

  const staleResult = await ingestObservation(
    buildObservation({
      observationId: "obs_w77_stale_older",
      projectId: actualProjectId,
      workloadId,
      observedAt: new Date("2026-10-18T12:00:00Z"),
      application: { image: "forge-api:v1", port: 8080 },
    })
  );
  assert.equal(staleResult.observationId, "obs_w77_stale_older");

  const latest = await getLatestObservation(actualProjectId, workloadId);
  assert.ok(latest);
  assert.equal(latest.observationId, "obs_w77_stale_newer");
  assert.equal(latest.observedAt.getTime(), Date.parse("2026-10-18T14:00:00Z"));

  const history = await listObservations(actualProjectId, workloadId);
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((o) => o.observationId),
    ["obs_w77_stale_older", "obs_w77_stale_newer"]
  );
});

test("INGEST: history is preserved — no observation is overwritten", async () => {
  assert.ok(actualProjectId);
  const workloadId = "history-check";

  for (let i = 1; i <= 3; i++) {
    await ingestObservation(
      buildObservation({
        observationId: `obs_w77_hist_${i}`,
        projectId: actualProjectId,
        workloadId,
        observedAt: new Date(`2026-10-18T10:0${i}:00Z`),
      })
    );
  }

  const history = await listObservations(actualProjectId, workloadId);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((o) => o.observationId),
    ["obs_w77_hist_1", "obs_w77_hist_2", "obs_w77_hist_3"]
  );

  const latest = await getLatestObservation(actualProjectId, workloadId);
  assert.ok(latest);
  assert.equal(latest.observationId, "obs_w77_hist_3");
});
