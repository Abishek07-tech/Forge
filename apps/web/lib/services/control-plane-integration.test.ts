import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type { DesiredState } from "../../types/desired-state.ts";
import { prisma } from "../prisma.ts";
import { deleteObservationsForProject } from "../persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../persistence/desired-state.ts";
import {
  deleteExecutionJobsForProject,
  getExecutionJobById,
  listExecutionJobs,
} from "../persistence/execution-job.ts";
import { createDesiredState } from "./desired-state.ts";
import { ingestObservation } from "./actual-state.ts";
import {
  advanceExecutionJob,
  evaluateResourceAndRequestExecution,
  getExecutionJob,
  listJobs,
} from "./control-plane.ts";

// Work 98 — end-to-end integration for the Control Plane foundation:
// Desired State + Actual State → evaluation → execution request (job)
// persisted → retrieved through the service layer → lifecycle advanced.
//
// A job is a recorded REQUEST. Nothing in this suite deploys, repairs, or
// reconciles infrastructure; no execution mechanism exists.

const projectName = "w98-control-plane-e2e";
const NOW = new Date("2026-10-24T12:00:00Z");
const FRESH = new Date("2026-10-24T11:58:00Z");

function buildDesiredState(projectId: string): DesiredState {
  return {
    desiredStateId: "ds_w98_v1",
    projectId,
    version: 1,
    createdAt: new Date("2026-10-24T08:00:00Z"),
    updatedAt: new Date("2026-10-24T08:00:00Z"),
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
    observedAt: FRESH,
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

async function resetProjectData(projectId: string): Promise<void> {
  await deleteExecutionJobsForProject(projectId);
  await deleteObservationsForProject(projectId);
  await deleteDesiredStatesForProject(projectId);
}

let projectId: string;

before(async () => {
  projectId = await ensureProject(projectName);
  await resetProjectData(projectId);
});

after(async () => {
  try {
    await resetProjectData(projectId);
    await prisma.project.deleteMany({ where: { name: projectName } });
  } finally {
    await prisma.$disconnect();
  }
});

test("W98 E2E: matching desired/actual state → no-action, no job created", async () => {
  await createDesiredState(buildDesiredState(projectId));
  await ingestObservation(buildObservation("obs_w98_match", projectId));

  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "no-action");
  assert.equal(outcome.outcome === "no-action" && outcome.comparison.outcome, "match");

  const jobs = await listExecutionJobs({ projectId });
  assert.equal(jobs.total, 0, "matching state must not create a job");
});

test("W98 E2E: missing observation → explicit observation-unavailable, no job", async () => {
  const workloadId = "never-observed";
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    workloadId,
    now: NOW,
  });
  assert.equal(outcome.outcome, "observation-unavailable");
  assert.ok("reason" in outcome && outcome.reason.length > 0);

  const jobs = await listExecutionJobs({ projectId, workloadId });
  assert.equal(jobs.total, 0);
});

test("W98 E2E: stale observation → explicit observation-stale, no job", async () => {
  await ingestObservation(
    buildObservation("obs_w98_stale_match", projectId, {
      workloadId: "stale-workload",
      observedAt: new Date("2026-10-24T10:00:00Z"),
    })
  );
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    workloadId: "stale-workload",
    now: NOW,
    staleAfterMs: 5 * 60 * 1000,
  });
  assert.equal(outcome.outcome, "observation-stale");
  assert.ok("ageMs" in outcome && outcome.ageMs > 5 * 60 * 1000);

  const jobs = await listExecutionJobs({ projectId, workloadId: "stale-workload" });
  assert.equal(jobs.total, 0, "stale evaluation must not request execution");
});

test("W98 E2E: drift → job created, persisted, retrievable, listed", async () => {
  await ingestObservation(
    buildObservation("obs_w98_drift", projectId, {
      application: { image: "forge-api:v0", port: 8080, version: "0.9.0" },
    })
  );

  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
    correlationId: "corr_w98_flow",
  });
  assert.equal(outcome.outcome, "execution-requested");
  if (outcome.outcome !== "execution-requested") return;

  assert.equal(outcome.comparison.outcome, "drift");
  assert.equal(outcome.job.status, "pending");
  assert.equal(outcome.job.correlationId, "corr_w98_flow");

  const persisted = await getExecutionJobById(outcome.job.jobId);
  assert.ok(persisted, "job must be persisted");
  assert.equal(persisted?.status, "pending");
  assert.equal(persisted?.desiredState.desiredStateId, "ds_w98_v1");
  assert.equal(persisted?.desiredState.version, 1);

  const viaService = await getExecutionJob(outcome.job.jobId);
  assert.equal(viaService.jobId, outcome.job.jobId);
  assert.equal(viaService.status, "pending");

  const listed = await listJobs(projectId, { status: "pending", limit: "10" });
  assert.equal(listed.total, 1);
  assert.equal(listed.jobs[0]?.jobId, outcome.job.jobId);

  // A pending job is a request only — it must not look like a deployment.
  assert.notEqual(outcome.job.status, "succeeded");
  assert.equal(outcome.job.startedAt, undefined);
  assert.equal(outcome.job.finishedAt, undefined);
});

test("W98 E2E: duplicate evaluation does not create a second job", async () => {
  const before = await listExecutionJobs({ projectId });

  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "already-active");
  if (outcome.outcome !== "already-active") return;
  assert.equal(outcome.job.status, "pending");

  const after = await listExecutionJobs({ projectId });
  assert.equal(after.total, before.total, "no duplicate job for same intent");
});

test("W98 E2E: lifecycle advances pending → queued → running → succeeded", async () => {
  const jobs = await listExecutionJobs({ projectId, status: "pending" });
  assert.equal(jobs.total, 1);
  const jobId = jobs.jobs[0]!.jobId;

  const queued = await advanceExecutionJob(jobId, "pending", "queued", {
    now: NOW,
  });
  assert.equal(queued.status, "queued");
  assert.ok(queued.queuedAt);

  const running = await advanceExecutionJob(jobId, "queued", "running", {
    now: NOW,
    incrementAttempt: true,
  });
  assert.equal(running.status, "running");
  assert.equal(running.attemptCount, 1);
  assert.ok(running.startedAt);

  const succeeded = await advanceExecutionJob(jobId, "running", "succeeded", {
    now: NOW,
  });
  assert.equal(succeeded.status, "succeeded");
  assert.ok(succeeded.finishedAt);
});

test("W98 E2E: invalid lifecycle transitions are rejected end-to-end", async () => {
  const jobs = await listExecutionJobs({ projectId, status: "succeeded" });
  assert.equal(jobs.total, 1);
  const jobId = jobs.jobs[0]!.jobId;

  await assert.rejects(
    () => advanceExecutionJob(jobId, "succeeded", "running"),
    /Invalid execution job transition/
  );
  await assert.rejects(
    () => advanceExecutionJob(jobId, "pending", "succeeded"),
    /Invalid execution job transition/
  );

  const unchanged = await getExecutionJobById(jobId);
  assert.equal(unchanged?.status, "succeeded", "rejected transitions leave state unchanged");
});

test("W98 E2E: terminal job allows a new request only after intent changes", async () => {
  // Job is terminal (succeeded) but drift still exists → a new request is allowed.
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(outcome.outcome, "execution-requested");
  if (outcome.outcome !== "execution-requested") return;
  assert.notEqual(outcome.job.status, "succeeded");

  // Re-evaluating the same intent must not stack another job.
  const repeat = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.equal(repeat.outcome, "already-active");

  const jobs = await listExecutionJobs({ projectId });
  assert.equal(jobs.total, 2, "one terminal + one active job for the intent");
});

test("W98 E2E: failed job records structured failure and is not a success", async () => {
  const jobs = await listExecutionJobs({ projectId, status: "pending" });
  assert.equal(jobs.total, 1);
  const jobId = jobs.jobs[0]!.jobId;

  const queued = await advanceExecutionJob(jobId, "pending", "queued", { now: NOW });
  assert.equal(queued.status, "queued");
  const failed = await advanceExecutionJob(jobId, "queued", "failed", {
    now: NOW,
    failure: {
      kind: "execution",
      message: "No execution mechanism is available to run this job.",
      code: "EXECUTION_UNAVAILABLE",
      occurredAt: NOW,
    },
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.failure?.code, "EXECUTION_UNAVAILABLE");
  assert.ok(failed.finishedAt);
  assert.notEqual(failed.status, "succeeded");
});

test("W98 E2E: unknown project → NOT_FOUND, not a fabricated evaluation", async () => {
  await assert.rejects(
    () => evaluateResourceAndRequestExecution("proj_does_not_exist_w98", { now: NOW }),
    /does not exist/
  );
});

test("W98 E2E: existing project without Desired State → desired-state-unavailable", async () => {
  const emptyProject = await ensureProject(`${projectName}-empty`);
  try {
    const outcome = await evaluateResourceAndRequestExecution(emptyProject, {
      now: NOW,
    });
    assert.equal(outcome.outcome, "desired-state-unavailable");
    const jobs = await listExecutionJobs({ projectId: emptyProject });
    assert.equal(jobs.total, 0);
  } finally {
    await prisma.project.deleteMany({ where: { name: `${projectName}-empty` } });
  }
});
