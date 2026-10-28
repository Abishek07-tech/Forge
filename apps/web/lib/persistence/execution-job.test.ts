import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { prisma } from "../prisma.ts";
import {
  createExecutionJob,
  deleteExecutionJobsForProject,
  DuplicateActiveJobError,
  DuplicateIdempotencyKeyError,
  findActiveJobForIntent,
  getExecutionJobById,
  getExecutionJobByIdempotencyKey,
  InvalidProjectError,
  listExecutionJobs,
  StaleStatusUpdateError,
  updateExecutionJobStatus,
  type ExecutionJobRecordInput,
} from "./execution-job.ts";

const KEEP = process.env.W94_KEEP === "1";
const mainProjectName = "w94-execution-jobs";

function buildJob(
  projectId: string,
  overrides: Partial<ExecutionJobRecordInput> = {}
): ExecutionJobRecordInput {
  const suffix = overrides.jobId ?? `job_w94_${Math.random().toString(36).slice(2, 10)}`;
  return {
    jobId: suffix,
    projectId,
    workloadId: "default",
    desiredStateId: "ds_w94_v1",
    desiredStateVersion: 1,
    jobType: "reconcile",
    status: "pending",
    idempotencyKey: `w94-key-${suffix}`,
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

let mainProjectId: string;

before(async () => {
  const existing = await prisma.project.findFirst({
    where: { name: mainProjectName },
  });
  mainProjectId =
    existing?.id ??
    (
      await prisma.project.create({
        data: { name: mainProjectName, status: "stopped", deployments: 0 },
      })
    ).id;

  if (!KEEP) {
    await deleteExecutionJobsForProject(mainProjectId);
  }
});

after(async () => {
  try {
    if (!KEEP) {
      await deleteExecutionJobsForProject(mainProjectId);
      await prisma.project.deleteMany({ where: { name: mainProjectName } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("PERSISTENCE: create + read back preserves all fields", async () => {
  const createdAt = new Date("2026-10-23T10:00:00Z");
  const input = buildJob(mainProjectId, {
    jobId: "job_w94_read",
    idempotencyKey: "w94-key-read",
    correlationId: "corr_w94_read",
    createdAt,
    updatedAt: createdAt,
  });
  const created = await createExecutionJob(input);
  assert.equal(created.jobId, "job_w94_read");
  assert.equal(created.projectId, mainProjectId);
  assert.equal(created.workloadId, "default");
  assert.deepEqual(created.desiredState, {
    desiredStateId: "ds_w94_v1",
    version: 1,
  });
  assert.equal(created.jobType, "reconcile");
  assert.equal(created.status, "pending");
  assert.equal(created.idempotencyKey, "w94-key-read");
  assert.equal(created.attemptCount, 0);
  assert.equal(created.maxAttempts, 3);
  assert.equal(created.correlationId, "corr_w94_read");
  assert.equal(created.failure, undefined);

  const read = await getExecutionJobById("job_w94_read");
  assert.ok(read);
  assert.equal(read?.status, "pending");
  assert.equal(read?.correlationId, "corr_w94_read");

  const byKey = await getExecutionJobByIdempotencyKey("w94-key-read");
  assert.ok(byKey);
  assert.equal(byKey?.jobId, "job_w94_read");
});

test("PERSISTENCE: unknown job and key return null", async () => {
  assert.equal(await getExecutionJobById("job_w94_missing"), null);
  assert.equal(
    await getExecutionJobByIdempotencyKey("w94-missing-key"),
    null
  );
});

test("PERSISTENCE: invalid project is rejected", async () => {
  await assert.rejects(
    () =>
      createExecutionJob(
        buildJob(mainProjectId, {
          jobId: "job_w94_bad_project",
          idempotencyKey: "w94-key-bad-project",
          projectId: "prj_does_not_exist",
        })
      ),
    InvalidProjectError
  );
});

test("PERSISTENCE: duplicate idempotency key is rejected", async () => {
  await createExecutionJob(
    buildJob(mainProjectId, {
      jobId: "job_w94_dup_a",
      idempotencyKey: "w94-key-shared",
      desiredStateId: "ds_w94_dup_a",
    })
  );
  await assert.rejects(
    () =>
      createExecutionJob(
        buildJob(mainProjectId, {
          jobId: "job_w94_dup_b",
          idempotencyKey: "w94-key-shared",
          // Different intent so only the idempotency-key constraint fires.
          desiredStateId: "ds_w94_dup_b",
        })
      ),
    DuplicateIdempotencyKeyError
  );
});

test("PERSISTENCE: only one active job per resource+intent (partial unique)", async () => {
  const active = await createExecutionJob(
    buildJob(mainProjectId, {
      jobId: "job_w94_active",
      idempotencyKey: "w94-key-active",
      desiredStateId: "ds_w94_active",
    })
  );
  assert.equal(active.status, "pending");

  await assert.rejects(
    () =>
      createExecutionJob(
        buildJob(mainProjectId, {
          jobId: "job_w94_active_conflict",
          idempotencyKey: "w94-key-active-conflict",
          desiredStateId: "ds_w94_active",
        })
      ),
    DuplicateActiveJobError
  );

  // After the active job is cancelled, a new job for the same intent is allowed.
  const cancelled = await updateExecutionJobStatus({
    jobId: "job_w94_active",
    expectedStatus: "pending",
    nextStatus: "cancelled",
    now: new Date("2026-10-23T10:05:00Z"),
  });
  assert.equal(cancelled.status, "cancelled");

  const replacement = await createExecutionJob(
    buildJob(mainProjectId, {
      jobId: "job_w94_active_after_cancel",
      idempotencyKey: "w94-key-active-after-cancel",
      desiredStateId: "ds_w94_active",
    })
  );
  assert.equal(replacement.status, "pending");
});

test("PERSISTENCE: findActiveJobForIntent locates active jobs only", async () => {
  const found = await findActiveJobForIntent(
    mainProjectId,
    "default",
    "ds_w94_active"
  );
  assert.ok(found);
  assert.equal(found?.jobId, "job_w94_active_after_cancel");

  const missing = await findActiveJobForIntent(
    mainProjectId,
    "default",
    "ds_w94_never"
  );
  assert.equal(missing, null);
});

test("PERSISTENCE: lifecycle status update stamps timestamps and attempts", async () => {
  const job = await createExecutionJob(
    buildJob(mainProjectId, {
      jobId: "job_w94_lifecycle",
      idempotencyKey: "w94-key-lifecycle",
      desiredStateId: "ds_w94_lifecycle",
    })
  );
  const now = new Date("2026-10-23T11:00:00Z");
  const queued = await updateExecutionJobStatus({
    jobId: job.jobId,
    expectedStatus: "pending",
    nextStatus: "queued",
    now,
  });
  assert.equal(queued.status, "queued");
  assert.equal(queued.queuedAt?.toISOString(), now.toISOString());

  const started = await updateExecutionJobStatus({
    jobId: job.jobId,
    expectedStatus: "queued",
    nextStatus: "running",
    now: new Date("2026-10-23T11:01:00Z"),
    incrementAttempt: true,
  });
  assert.equal(started.status, "running");
  assert.ok(started.startedAt);
  assert.equal(started.attemptCount, 1);

  const failed = await updateExecutionJobStatus({
    jobId: job.jobId,
    expectedStatus: "running",
    nextStatus: "failed",
    now: new Date("2026-10-23T11:02:00Z"),
    failure: {
      kind: "execution",
      message: "worker rejected the job",
      code: "EXECUTION_REJECTED",
      occurredAt: new Date("2026-10-23T11:02:00Z"),
    },
  });
  assert.equal(failed.status, "failed");
  assert.ok(failed.finishedAt);
  assert.equal(failed.failure?.kind, "execution");
  assert.equal(failed.failure?.code, "EXECUTION_REJECTED");
});

test("PERSISTENCE: conflicting lifecycle update is rejected (optimistic lock)", async () => {
  const job = await createExecutionJob(
    buildJob(mainProjectId, {
      jobId: "job_w94_conflict",
      idempotencyKey: "w94-key-conflict",
      desiredStateId: "ds_w94_conflict",
    })
  );

  // First writer wins.
  await updateExecutionJobStatus({
    jobId: job.jobId,
    expectedStatus: "pending",
    nextStatus: "queued",
    now: new Date("2026-10-23T12:00:00Z"),
  });

  // Second writer still believes the job is pending.
  await assert.rejects(
    () =>
      updateExecutionJobStatus({
        jobId: job.jobId,
        expectedStatus: "pending",
        nextStatus: "cancelled",
        now: new Date("2026-10-23T12:00:01Z"),
      }),
    StaleStatusUpdateError
  );

  // Job is still queued — the rejected update did not apply.
  const read = await getExecutionJobById(job.jobId);
  assert.equal(read?.status, "queued");
});

test("PERSISTENCE: list supports filters, pagination, and totals", async () => {
  await deleteExecutionJobsForProject(mainProjectId);

  for (let i = 0; i < 5; i += 1) {
    await createExecutionJob(
      buildJob(mainProjectId, {
        jobId: `job_w94_list_${i}`,
        idempotencyKey: `w94-key-list-${i}`,
        desiredStateId: `ds_w94_list_${i}`,
        status: i % 2 === 0 ? "pending" : "queued",
        jobType: i === 4 ? "deploy" : "reconcile",
        workloadId: i === 3 ? "worker" : "default",
      })
    );
  }

  const all = await listExecutionJobs({ projectId: mainProjectId });
  assert.equal(all.total, 5);
  assert.equal(all.jobs.length, 5);
  assert.equal(all.limit, 50);
  assert.equal(all.offset, 0);

  const pending = await listExecutionJobs({
    projectId: mainProjectId,
    status: "pending",
  });
  assert.equal(pending.total, 3);

  const deploy = await listExecutionJobs({
    projectId: mainProjectId,
    jobType: "deploy",
  });
  assert.equal(deploy.total, 1);
  assert.equal(deploy.jobs[0]?.jobId, "job_w94_list_4");

  const worker = await listExecutionJobs({
    projectId: mainProjectId,
    workloadId: "worker",
  });
  assert.equal(worker.total, 1);

  const page = await listExecutionJobs({
    projectId: mainProjectId,
    limit: 2,
    offset: 2,
  });
  assert.equal(page.jobs.length, 2);
  assert.equal(page.total, 5);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 2);
});
