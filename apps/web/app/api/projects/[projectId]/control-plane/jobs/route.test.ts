import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { prisma } from "../../../../../../lib/prisma.ts";
import { deleteObservationsForProject } from "../../../../../../lib/persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../../../../../../lib/persistence/desired-state.ts";
import {
  deleteExecutionJobsForProject,
  createExecutionJob,
} from "../../../../../../lib/persistence/execution-job.ts";
import { GET as GET_LIST } from "./route.ts";
import { GET as GET_ONE } from "./[jobId]/route.ts";

const projectName = "w97-jobs-route";

function request(url: string): NextRequest {
  return new Request(url, { method: "GET" }) as unknown as NextRequest;
}

function listContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function oneContext(projectId: string, jobId: string) {
  return { params: Promise.resolve({ projectId, jobId }) };
}

let projectId: string;
let jobA: string;

before(async () => {
  const existing = await prisma.project.findFirst({
    where: { name: projectName },
  });
  projectId =
    existing?.id ??
    (
      await prisma.project.create({
        data: { name: projectName, status: "stopped", deployments: 0 },
      })
    ).id;
  await deleteExecutionJobsForProject(projectId);

  const now = new Date("2026-10-23T12:00:00Z");
  const a = await createExecutionJob({
    jobId: "job_w97_list_a",
    projectId,
    workloadId: "default",
    desiredStateId: "ds_w97_a",
    desiredStateVersion: 1,
    jobType: "reconcile",
    status: "pending",
    idempotencyKey: "w97-key-a",
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  });
  await createExecutionJob({
    jobId: "job_w97_list_b",
    projectId,
    workloadId: "worker",
    desiredStateId: "ds_w97_b",
    desiredStateVersion: 2,
    jobType: "deploy",
    status: "queued",
    idempotencyKey: "w97-key-b",
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
    queuedAt: now,
  });
  jobA = a.jobId;
});

after(async () => {
  try {
    await deleteExecutionJobsForProject(projectId);
    await deleteObservationsForProject(projectId);
    await deleteDesiredStatesForProject(projectId);
    await prisma.project.deleteMany({ where: { name: projectName } });
  } finally {
    await prisma.$disconnect();
  }
});

test("ROUTE: GET job by id returns the job", async () => {
  const response = await GET_ONE(
    request("http://test.local/jobs/x"),
    oneContext(projectId, jobA)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.jobId, "job_w97_list_a");
  assert.equal(body.data.status, "pending");
  assert.deepEqual(body.data.desiredState, {
    desiredStateId: "ds_w97_a",
    version: 1,
  });
  assert.ok(body.data.createdAt);
});

test("ROUTE: GET unknown job returns 404", async () => {
  const response = await GET_ONE(
    request("http://test.local/jobs/x"),
    oneContext(projectId, "job_missing_w97")
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("ROUTE: GET list returns jobs with totals and pagination", async () => {
  const response = await GET_LIST(
    request("http://test.local/jobs"),
    listContext(projectId)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.total, 2);
  assert.equal(body.data.jobs.length, 2);
  assert.equal(body.data.limit, 50);
  assert.equal(body.data.offset, 0);
});

test("ROUTE: GET list filters by status and workload", async () => {
  const queued = await GET_LIST(
    request("http://test.local/jobs?status=queued"),
    listContext(projectId)
  );
  const queuedBody = await queued.json();
  assert.equal(queuedBody.data.total, 1);
  assert.equal(queuedBody.data.jobs[0].jobId, "job_w97_list_b");

  const worker = await GET_LIST(
    request("http://test.local/jobs?workloadId=worker"),
    listContext(projectId)
  );
  const workerBody = await worker.json();
  assert.equal(workerBody.data.total, 1);
  assert.equal(workerBody.data.jobs[0].jobId, "job_w97_list_b");

  const deploy = await GET_LIST(
    request("http://test.local/jobs?jobType=deploy"),
    listContext(projectId)
  );
  const deployBody = await deploy.json();
  assert.equal(deployBody.data.total, 1);

  const page = await GET_LIST(
    request("http://test.local/jobs?limit=1&offset=1"),
    listContext(projectId)
  );
  const pageBody = await page.json();
  assert.equal(pageBody.data.limit, 1);
  assert.equal(pageBody.data.offset, 1);
  assert.equal(pageBody.data.jobs.length, 1);
  assert.equal(pageBody.data.total, 2);
});

test("ROUTE: GET list rejects invalid filters with 400", async () => {
  for (const query of [
    "status=paused",
    "jobType=explode",
    "limit=0",
    "limit=abc",
    "offset=-1",
  ]) {
    const response = await GET_LIST(
      request(`http://test.local/jobs?${query}`),
      listContext(projectId)
    );
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.equal(body.success, false, query);
  }
});

test("ROUTE: GET list for unknown project returns 404", async () => {
  const response = await GET_LIST(
    request("http://test.local/jobs"),
    listContext("prj_missing_w97")
  );
  assert.equal(response.status, 404);
});
