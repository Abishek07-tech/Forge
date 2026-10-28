import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { ActualStateObservation } from "../../types/actual-state.ts";
import type { DesiredState } from "../../types/desired-state.ts";
import { prisma } from "../prisma.ts";
import { deleteObservationsForProject } from "../persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../persistence/desired-state.ts";
import {
  createExecutionJob,
  deleteExecutionJobsForProject,
  InvalidProjectError,
  type ExecutionJobRecordInput,
} from "../persistence/execution-job.ts";
import { classifyFailure } from "../resilience/classify.ts";
import {
  RetryExhaustedError,
  withRetry,
} from "../resilience/retry.ts";
import {
  advanceExecutionJob,
  ControlPlaneConflictError,
  ControlPlaneServiceError,
  evaluateResourceAndRequestExecution,
} from "./control-plane.ts";
import { createDesiredState } from "./desired-state.ts";

const KEEP = process.env.W96_KEEP === "1";
const projectName = "w96-idempotency";
const NOW = new Date("2026-10-23T12:00:00Z");

function buildDesiredState(projectId: string): DesiredState {
  return {
    desiredStateId: "ds_w96_v1",
    projectId,
    version: 1,
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
    observedAt: new Date("2026-10-23T11:59:00Z"),
    status: "running",
    application: { image: "forge-api:v0", port: 8080, version: "0.9.0" },
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
  await createDesiredState(buildDesiredState(projectId));
  await ingestDriftedObservation("obs_w96_drift");
});

async function ingestDriftedObservation(observationId: string): Promise<void> {
  const existing = await prisma.actualStateObservation.findUnique({
    where: { observationId },
  });
  if (!existing) {
    await prisma.actualStateObservation.create({
      data: {
        observationId,
        projectId,
        workloadId: "default",
        source: "test-harness",
        observedAt: buildObservation(observationId, projectId).observedAt,
        status: "running",
        data: {
          application: { image: "forge-api:v0", port: 8080, version: "0.9.0" },
          runtime: { replicas: 2 },
          resources: { cpu: "250m", memory: "256Mi" },
          environment: { NODE_ENV: "production" },
          deployment: { version: 1 },
          health: { status: "healthy" },
        },
      },
    });
  }
}

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

test("IDEMPOTENCY: classification of control-plane failures", () => {
  assert.equal(
    classifyFailure(
      Object.assign(new Error("nope"), {
        name: "InvalidJobTransitionServiceError",
      })
    ).disposition,
    "invalid"
  );
  for (const name of [
    "ControlPlaneNotFoundError",
    "ControlPlaneConflictError",
    "DuplicateActiveJobError",
    "DuplicateIdempotencyKeyError",
    "StaleStatusUpdateError",
  ]) {
    const classified = classifyFailure(
      Object.assign(new Error("nope"), { name })
    );
    assert.equal(classified.disposition, "permanent", name);
  }
  // PERSISTENCE_FAILED stays retryable.
  const persistence = classifyFailure(
    Object.assign(new Error("db down"), {
      name: "ControlPlaneServiceError",
      code: "PERSISTENCE_FAILED",
    })
  );
  assert.equal(persistence.disposition, "retryable");
});

test("IDEMPOTENCY: concurrent evaluations create exactly one job", async () => {
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      evaluateResourceAndRequestExecution(projectId, { now: NOW })
    )
  );

  const jobIds = new Set(
    results.map((result) => ("job" in result ? result.job.jobId : "none"))
  );
  assert.equal(jobIds.size, 1, "all concurrent evaluations observe one job");

  for (const result of results) {
    assert.ok(
      result.outcome === "execution-requested" ||
        result.outcome === "already-active",
      `unexpected outcome ${result.outcome}`
    );
  }

  const activeCount = await prisma.executionJob.count({
    where: {
      projectId,
      status: { in: ["pending", "queued", "running"] },
    },
  });
  assert.equal(activeCount, 1);
});

test("IDEMPOTENCY: concurrent creates with the same client key produce one job", async () => {
  await prisma.executionJob.deleteMany({
    where: { idempotencyKey: "w96-concurrent-key" },
  });

  // Cancel any active job for the default intent so creation is attempted.
  const active = await prisma.executionJob.findFirst({
    where: {
      projectId,
      workloadId: "default",
      status: { in: ["pending", "queued", "running"] },
    },
  });
  if (active) {
    await advanceExecutionJob(active.jobId, active.status, "cancelled", {
      now: NOW,
    });
  }

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      evaluateResourceAndRequestExecution(projectId, {
        now: NOW,
        idempotencyKey: "w96-concurrent-key",
      })
    )
  );

  const jobIds = new Set(
    results.map((result) => ("job" in result ? result.job.jobId : "none"))
  );
  assert.equal(jobIds.size, 1);

  const total = await prisma.executionJob.count({
    where: { idempotencyKey: "w96-concurrent-key" },
  });
  assert.equal(total, 1);
});

test("IDEMPOTENCY: transient failure retried without duplicate jobs", async () => {
  const input: ExecutionJobRecordInput = {
    jobId: "job_w96_retry",
    projectId,
    workloadId: "retry-wl",
    desiredStateId: "ds_w96_retry",
    desiredStateVersion: 1,
    jobType: "reconcile",
    status: "pending",
    idempotencyKey: "w96-retry-key",
    attemptCount: 0,
    maxAttempts: 3,
  };

  let attempts = 0;
  const flakyCreate = async (): Promise<unknown> => {
    attempts += 1;
    if (attempts === 1) {
      // Transient failure BEFORE the write reaches the database.
      const error = new Error("connection dropped");
      error.name = "PrismaClientKnownRequestError";
      Object.assign(error, { code: "PERSISTENCE_FAILED" });
      throw error;
    }
    return createExecutionJob(input);
  };

  const job = (await withRetry(flakyCreate, {
    maxAttempts: 3,
    baseDelayMs: 1,
    operationName: "createExecutionJob",
  })) as Awaited<ReturnType<typeof createExecutionJob>>;

  assert.equal(job.jobId, "job_w96_retry");
  assert.equal(attempts, 2);

  const total = await prisma.executionJob.count({
    where: { idempotencyKey: "w96-retry-key" },
  });
  assert.equal(total, 1, "bounded retry must not duplicate the job");
});

test("IDEMPOTENCY: exhausted transient retries leave no job behind", async () => {
  let attempts = 0;
  const alwaysTransient = async (): Promise<unknown> => {
    attempts += 1;
    const error = new Error("connection dropped");
    Object.assign(error, { code: "PERSISTENCE_FAILED" });
    throw error;
  };

  await assert.rejects(
    () =>
      withRetry(alwaysTransient, {
        maxAttempts: 2,
        baseDelayMs: 1,
        operationName: "createExecutionJob",
      }),
    RetryExhaustedError
  );
  assert.equal(attempts, 2, "retry attempts are bounded");

  const total = await prisma.executionJob.count({
    where: { projectId, workloadId: "never-created" },
  });
  assert.equal(total, 0);
});

test("IDEMPOTENCY: permanent failures are never retried", async () => {
  let attempts = 0;
  const permanent = async (): Promise<unknown> => {
    attempts += 1;
    return createExecutionJob({
      jobId: "job_w96_permanent",
      projectId: "prj_missing",
      workloadId: "default",
      desiredStateId: "ds_x",
      desiredStateVersion: 1,
      jobType: "reconcile",
      status: "pending",
      idempotencyKey: "w96-permanent-key",
      attemptCount: 0,
      maxAttempts: 3,
    });
  };

  await assert.rejects(
    () =>
      withRetry(permanent, {
        maxAttempts: 3,
        baseDelayMs: 1,
        operationName: "createExecutionJob",
      }),
    InvalidProjectError
  );
  assert.equal(attempts, 1, "permanent failures must not be retried");
});

test("IDEMPOTENCY: validation failures are classified invalid, not retried", async () => {
  let attempts = 0;
  const invalid = async (): Promise<unknown> => {
    attempts += 1;
    throw Object.assign(new Error("bad input"), {
      name: "InvalidJobTransitionServiceError",
    });
  };
  await assert.rejects(
    () =>
      withRetry(invalid, { maxAttempts: 3, baseDelayMs: 1 }),
    Error
  );
  assert.equal(attempts, 1);
});

test("IDEMPOTENCY: conflicting lifecycle updates are rejected at service level", async () => {
  const outcome = await evaluateResourceAndRequestExecution(projectId, {
    now: NOW,
  });
  assert.ok("job" in outcome);
  const jobId = "job" in outcome ? outcome.job.jobId : "";
  const job = await prisma.executionJob.findUnique({ where: { jobId } });
  assert.ok(job);

  // First writer advances pending → queued.
  await advanceExecutionJob(jobId, "pending", "queued", { now: NOW });

  // Second writer still believes the job is pending.
  await assert.rejects(
    () => advanceExecutionJob(jobId, "pending", "cancelled", { now: NOW }),
    ControlPlaneConflictError
  );

  const after = await prisma.executionJob.findUnique({ where: { jobId } });
  assert.equal(after?.status, "queued");
});

test("IDEMPOTENCY: blank idempotency key fails fast as invalid", async () => {
  await assert.rejects(
    () =>
      evaluateResourceAndRequestExecution(projectId, {
        now: NOW,
        idempotencyKey: "",
      }),
    ControlPlaneServiceError
  );
});
