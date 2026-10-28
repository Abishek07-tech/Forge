import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/prisma.ts";
import { deleteObservationsForProject } from "../../../../../lib/persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../../../../../lib/persistence/desired-state.ts";
import { deleteExecutionJobsForProject } from "../../../../../lib/persistence/execution-job.ts";
import { createDesiredState } from "../../../../../lib/services/desired-state.ts";
import type { DesiredState } from "../../../../../types/desired-state.ts";
import { POST as EVALUATE } from "./evaluate/route.ts";
import { GET as LIST_JOBS } from "./jobs/route.ts";
import { GET as GET_JOB } from "./jobs/[jobId]/route.ts";

// Work 98 — API-level end-to-end: evaluate → job returned → job retrievable
// by id → job listed with filters. Creating a job records a request; these
// responses are not evidence of any infrastructure change.

const projectName = "w98-e2e-control-plane-api";

function request(url: string, body?: unknown, method = "POST"): NextRequest {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

function evaluateContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function jobContext(projectId: string, jobId: string) {
  return { params: Promise.resolve({ projectId, jobId }) };
}

function desiredState(projectId: string): DesiredState {
  return {
    desiredStateId: "ds_w98_api_v1",
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

async function ensureProject(name: string): Promise<string> {
  const existing = await prisma.project.findFirst({ where: { name } });
  if (existing) return existing.id;
  const created = await prisma.project.create({
    data: { name, status: "stopped", deployments: 0 },
  });
  return created.id;
}

let projectId: string;
let otherProjectId: string;
let jobId: string | undefined;

before(async () => {
  projectId = await ensureProject(projectName);
  otherProjectId = await ensureProject(`${projectName}-other`);
  await deleteExecutionJobsForProject(projectId);
  await deleteObservationsForProject(projectId);
  await deleteDesiredStatesForProject(projectId);
  await createDesiredState(desiredState(projectId));
  // Drifted observation, fresh relative to the real clock (stale window: 5 min).
  await prisma.actualStateObservation.create({
    data: {
      observationId: "obs_w98_api_drift",
      projectId,
      workloadId: "default",
      source: "test-harness",
      observedAt: new Date(Date.now() - 60_000),
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
});

after(async () => {
  try {
    for (const id of [projectId, otherProjectId]) {
      await deleteExecutionJobsForProject(id);
      await deleteObservationsForProject(id);
      await deleteDesiredStatesForProject(id);
    }
    await prisma.project.deleteMany({
      where: { name: { in: [projectName, `${projectName}-other`] } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

test("W98 API E2E: evaluate → fetch by id → list, with a duplicate-safe repeat", async () => {
  const evaluateResponse = await EVALUATE(
    request("http://test.local/evaluate", {}),
    evaluateContext(projectId)
  );
  assert.equal(evaluateResponse.status, 200);
  const evaluateBody = await evaluateResponse.json();
  assert.equal(evaluateBody.success, true);
  assert.equal(evaluateBody.data.outcome, "execution-requested");
  assert.equal(evaluateBody.data.job.status, "pending");
  assert.equal(evaluateBody.data.comparison.outcome, "drift");
  jobId = evaluateBody.data.job.jobId;

  const fetchResponse = await GET_JOB(
    request(`http://test.local/jobs/${jobId}`, undefined, "GET"),
    jobContext(projectId, jobId!)
  );
  assert.equal(fetchResponse.status, 200);
  const fetchBody = await fetchResponse.json();
  assert.equal(fetchBody.success, true);
  assert.equal(fetchBody.data.jobId, jobId);
  assert.equal(fetchBody.data.status, "pending");
  assert.equal(fetchBody.data.projectId, projectId);
  // Recorded request ≠ executed deployment.
  assert.notEqual(fetchBody.data.status, "succeeded");
  assert.equal(fetchBody.data.startedAt, undefined);

  const listResponse = await LIST_JOBS(
    request(
      `http://test.local/jobs?status=pending&workloadId=default&limit=10`,
      undefined,
      "GET"
    ),
    evaluateContext(projectId)
  );
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.equal(listBody.success, true);
  assert.equal(listBody.data.total, 1);
  assert.equal(listBody.data.jobs[0].jobId, jobId);

  // Repeating the identical request must not create another job.
  const repeatResponse = await EVALUATE(
    request("http://test.local/evaluate", {}),
    evaluateContext(projectId)
  );
  const repeatBody = await repeatResponse.json();
  assert.equal(repeatBody.success, true);
  assert.equal(repeatBody.data.outcome, "already-active");
  assert.equal(repeatBody.data.job.jobId, jobId);

  const recount = await LIST_JOBS(
    request("http://test.local/jobs", undefined, "GET"),
    evaluateContext(projectId)
  );
  const recountBody = await recount.json();
  assert.equal(recountBody.data.total, 1, "repeat evaluate must not duplicate jobs");
});

test("W98 API E2E: job is not readable through another project's route", async () => {
  assert.ok(jobId);
  const response = await GET_JOB(
    request(`http://test.local/jobs/${jobId}`, undefined, "GET"),
    jobContext(otherProjectId, jobId!)
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("W98 API E2E: missing observation yields an explicit outcome, not an error", async () => {
  const response = await EVALUATE(
    request("http://test.local/evaluate", { workloadId: "unobserved" }),
    evaluateContext(projectId)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.outcome, "observation-unavailable");
});

test("W98 API E2E: validation failures are 400 with field errors", async () => {
  const response = await EVALUATE(
    request("http://test.local/evaluate", { workloadId: "" }),
    evaluateContext(projectId)
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.ok(Array.isArray(body.errors) && body.errors.length > 0);
});

test("W98 API E2E: unknown job and unknown project return 404", async () => {
  const missingJob = await GET_JOB(
    request("http://test.local/jobs/nope", undefined, "GET"),
    jobContext(projectId, "job_does_not_exist_w98")
  );
  assert.equal(missingJob.status, 404);

  const missingProject = await LIST_JOBS(
    request("http://test.local/jobs", undefined, "GET"),
    evaluateContext("proj_does_not_exist_w98")
  );
  assert.equal(missingProject.status, 404);

  const unknownEvaluate = await EVALUATE(
    request("http://test.local/evaluate", {}),
    evaluateContext("proj_does_not_exist_w98")
  );
  assert.equal(unknownEvaluate.status, 404);
});

test("W98 API E2E: internal failures never leak stack traces or secrets", async () => {
  const response = await EVALUATE(
    request("http://test.local/evaluate", { idempotencyKey: "" }),
    evaluateContext(projectId)
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("    at "), "no stack frames in response");
  assert.ok(!/DATABASE_URL|password|secret/i.test(serialized), "no secrets in response");
});
