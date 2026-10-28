import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type { DesiredState } from "../../types/desired-state.ts";
import { prisma } from "../prisma.ts";
import { deleteObservationsForProject } from "../persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../persistence/desired-state.ts";
import { deleteExecutionJobsForProject } from "../persistence/execution-job.ts";
import { createDesiredState } from "./desired-state.ts";
import { ingestObservation } from "./actual-state.ts";
import {
  ControlPlaneNotFoundError,
  ControlPlaneServiceError,
  deriveIdempotencyKey,
  evaluateResourceAndRequestExecution,
  advanceExecutionJob,
  getExecutionJob,
  InvalidJobTransitionServiceError,
} from "./control-plane.ts";
import { getExecutionJobById } from "../persistence/execution-job.ts";

const KEEP = process.env.W95_KEEP === "1";
const projectName = "w95-control-plane";
const NOW = new Date("2026-10-23T12:00:00Z");

function buildDesiredState(projectId: string, version = 1): DesiredState {
  return {
    desiredStateId: `ds_w95_v${version}`,
    projectId,
    version,
    createdAt: new Date("2026-10-23T08:00:00Z"),
    updatedAt: new Date("2026-10-23T08:00:00Z"),
    applications: { image: "forge-api:v1", port: 8080, version: "1.0.0" },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
    health: { path: "/health" },
  };
}

function buildObservation(
  observationId: string,
  projectId: string,
  overrides: Partial<ActualStateObservation> = {}
): ActualStateObservation {
  return {
    observationId,
    projectId,
    workloadId: "default",
    source: "test-harness",
    observedAt: new Date("2026-10-23T11:55:00Z"),
    status: "running",
    application: { image: "forge-api:v1", port: 8080, version: "1.0.0" },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
    health: { status: "healthy" },
    ...overrides,
  };
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

let projectId: string;

before(async () => {
  projectId = await ensureProject(projectName);
  if (!KEEP) {
    await deleteExecutionJobsForProject(projectId);
    await deleteObservationsForProject(projectId);
    await deleteDesiredStatesForProject(projectId);
  }
});

after(async () => {
  try {
    if (!KEEP) {
      await deleteExecutionJobsForProject(projectId);
      await deleteObservationsForProject(projectId);
      await deleteDesiredStatesForProject(projectId);
      await prisma.project.deleteMany({ where: { name: projectName } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("CONTROL-PLANE: desired-state-unavailable when no Desired State exists", async () => {
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "desired-state-unavailable");
});

test("CONTROL-PLANE: observation-unavailable when Actual State is missing", async () => {
  await createDesiredState(buildDesiredState(projectId, 1));
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "observation-unavailable");
  assert.ok("reason" in outcome && outcome.reason.length > 0);
});

test("CONTROL-PLANE: matching state → no-action, no job created", async () => {
  await ingestObservation(
    buildObservation("obs_w95_match", projectId, {
      observedAt: new Date("2026-10-23T11:58:00Z"),
    })
  );
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "no-action");
  assert.ok("comparison" in outcome);
  assert.equal(outcome.outcome === "no-action" && outcome.comparison.outcome, "match");

  const jobs = await prisma.executionJob.findMany({ where: { projectId } });
  assert.equal(jobs.length, 0, "no job should be created on match");
});

test("CONTROL-PLANE: stale observation → observation-stale, no job", async () => {
  // Fresh matching observation exists; add a much older drifted one and use a
  // tiny stale window so the newest (matching) one is still selected but is
  // considered stale relative to `now`.
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: new Date("2026-10-23T13:00:00Z"),
    staleAfterMs: 60 * 1000, // newest obs is 11:58 → age ~62 min
  });
  assert.equal(outcome.outcome, "observation-stale");
  assert.ok("ageMs" in outcome && outcome.ageMs > 60 * 1000);
});

test("CONTROL-PLANE: drift → execution-requested with pending job", async () => {
  await ingestObservation(
    buildObservation("obs_w95_drift", projectId, {
      observedAt: new Date("2026-10-23T11:59:00Z"),
      application: { image: "forge-api:v0", port: 8080, version: "0.9.0" },
    })
  );
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "execution-requested");
  assert.ok("job" in outcome);
  if (outcome.outcome !== "execution-requested") {
    return;
  }
  assert.equal(outcome.job.status, "pending");
  assert.equal(outcome.job.jobType, "reconcile");
  assert.equal(outcome.job.projectId, projectId);
  assert.equal(outcome.job.workloadId, "default");
  assert.equal(outcome.job.desiredState.desiredStateId, "ds_w95_v1");
  assert.equal(outcome.job.desiredState.version, 1);
  assert.equal(
    outcome.job.idempotencyKey,
    deriveIdempotencyKey("reconcile", projectId, "default", "ds_w95_v1")
  );
  assert.equal(outcome.comparison.outcome, "drift");

  const persisted = await getExecutionJobById(outcome.job.jobId);
  assert.ok(persisted);
  assert.equal(persisted?.status, "pending");
});

test("CONTROL-PLANE: repeated evaluation for same intent → already-active (no duplicate)", async () => {
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "already-active");
  assert.ok("job" in outcome);

  const activeJobs = await prisma.executionJob.findMany({
    where: {
      projectId,
      status: { in: ["pending", "queued", "running"] },
    },
  });
  assert.equal(activeJobs.length, 1);
});

test("CONTROL-PLANE: after job terminal, new drift can request a new job", async () => {
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "already-active");
  assert.ok("job" in outcome);
  const jobId = outcome.outcome === "already-active" ? outcome.job.jobId : "";
  await advanceExecutionJob(jobId, "pending", "cancelled", {
    now: new Date("2026-10-23T12:01:00Z"),
  });

  const next = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(next.outcome, "execution-requested");
  assert.ok("job" in next);
  if (next.outcome === "execution-requested") {
    assert.notEqual(next.job.jobId, jobId);
  }
});

test("CONTROL-PLANE: client idempotency key replays the same job (active)", async () => {
  await ingestObservation(
    buildObservation("obs_w95_ck_active", projectId, {
      workloadId: "w95-ck-active",
      observedAt: new Date("2026-10-23T11:59:00Z"),
      application: { image: "forge-api:v0", port: 8080, version: "0.9.0" },
    })
  );
  const first = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
    workloadId: "w95-ck-active",
    idempotencyKey: "w95-client-key-1",
  });
  assert.equal(first.outcome, "execution-requested");
  if (first.outcome !== "execution-requested") return;
  const firstJobId = first.job.jobId;

  const replay = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
    workloadId: "w95-ck-active",
    idempotencyKey: "w95-client-key-1",
  });
  assert.equal(replay.outcome, "already-active");
  assert.ok("job" in replay);
  assert.equal(replay.job.jobId, firstJobId);

  const total = await prisma.executionJob.count({
    where: { idempotencyKey: "w95-client-key-1" },
  });
  assert.equal(total, 1);
});

test("CONTROL-PLANE: client key on a terminal job replays without creating a job", async () => {
  await ingestObservation(
    buildObservation("obs_w95_ck_terminal", projectId, {
      workloadId: "w95-ck-terminal",
      observedAt: new Date("2026-10-23T11:59:00Z"),
      application: { image: "forge-api:v0", port: 8080, version: "0.9.0" },
    })
  );
  const first = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
    workloadId: "w95-ck-terminal",
    idempotencyKey: "w95-client-key-2",
  });
  assert.equal(first.outcome, "execution-requested");
  if (first.outcome !== "execution-requested") return;
  const jobId = first.job.jobId;
  await advanceExecutionJob(jobId, "pending", "cancelled", {
    now: new Date("2026-10-23T12:02:00Z"),
  });

  const replay = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
    workloadId: "w95-ck-terminal",
    idempotencyKey: "w95-client-key-2",
  });
  assert.equal(replay.outcome, "already-recorded");
  assert.ok("job" in replay);
  assert.equal(replay.job.jobId, jobId);

  const total = await prisma.executionJob.count({
    where: { idempotencyKey: "w95-client-key-2" },
  });
  assert.equal(total, 1);
});

test("CONTROL-PLANE: blank client idempotency key fails validation", async () => {
  await assert.rejects(
    () =>
      evaluateResourceAndRequestExecution(projectId, {
        now: NOW,
        idempotencyKey: "   ",
      }),
    ControlPlaneServiceError
  );
});

test("CONTROL-PLANE: invalid lifecycle transitions are rejected by the service", async () => {
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.ok("job" in outcome);
  const jobId = "job" in outcome ? outcome.job.jobId : "";
  await assert.rejects(
    () => advanceExecutionJob(jobId, "pending", "succeeded", { now: NOW }),
    InvalidJobTransitionServiceError
  );
});

test("CONTROL-PLANE: getExecutionJob throws NOT_FOUND for unknown job", async () => {
  await assert.rejects(
    () => getExecutionJob("job_does_not_exist"),
    ControlPlaneNotFoundError
  );
});

test("CONTROL-PLANE: empty projectId fails validation", async () => {
  await assert.rejects(
    () => evaluateResourceAndRequestExecution("  ", { now: NOW }),
    ControlPlaneServiceError
  );
});

test("CONTROL-PLANE: unknown project throws NOT_FOUND, not desired-state-unavailable", async () => {
  await assert.rejects(
    () =>
      evaluateResourceAndRequestExecution("prj_w95_unknown", { now: NOW }),
    ControlPlaneNotFoundError
  );
});

test("CONTROL-PLANE: listJobs returns filters, pagination, and totals", async () => {
  const { listJobs } = await import("./control-plane.ts");
  const all = await listJobs(projectId);
  assert.ok(all.total >= 1);
  assert.ok(all.jobs.length >= 1);
  assert.equal(all.limit, 50);
  assert.equal(all.offset, 0);

  const pendingOnly = await listJobs(projectId, { status: "pending" });
  for (const job of pendingOnly.jobs) {
    assert.equal(job.status, "pending");
  }

  const paged = await listJobs(projectId, { limit: "1", offset: "0" });
  assert.equal(paged.limit, 1);
  assert.equal(paged.jobs.length, 1);

  const byWorkload = await listJobs(projectId, {
    workloadId: "w95-ck-active",
  });
  assert.equal(byWorkload.total, 1);
});

test("CONTROL-PLANE: listJobs validation failures", async () => {
  const { listJobs } = await import("./control-plane.ts");
  await assert.rejects(
    () => listJobs(projectId, { status: "paused" }),
    ControlPlaneServiceError
  );
  await assert.rejects(
    () => listJobs(projectId, { jobType: "explode" }),
    ControlPlaneServiceError
  );
  await assert.rejects(
    () => listJobs(projectId, { limit: "0" }),
    ControlPlaneServiceError
  );
  await assert.rejects(
    () => listJobs(projectId, { limit: "999" }),
    ControlPlaneServiceError
  );
  await assert.rejects(
    () => listJobs(projectId, { offset: "-1" }),
    ControlPlaneServiceError
  );
  await assert.rejects(
    () => listJobs("prj_w95_unknown"),
    ControlPlaneNotFoundError
  );
});
