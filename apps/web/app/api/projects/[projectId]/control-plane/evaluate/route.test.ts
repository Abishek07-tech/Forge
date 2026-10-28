import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { prisma } from "../../../../../../lib/prisma.ts";
import { deleteObservationsForProject } from "../../../../../../lib/persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../../../../../../lib/persistence/desired-state.ts";
import { deleteExecutionJobsForProject } from "../../../../../../lib/persistence/execution-job.ts";
import { createDesiredState } from "../../../../../../lib/services/desired-state.ts";
import type { DesiredState } from "../../../../../../types/desired-state.ts";
import { POST } from "./route.ts";

const projectName = "w97-evaluate-route";

function request(body?: unknown, method = "POST"): NextRequest {
  return new Request("http://test.local/evaluate", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function desiredState(projectId: string): DesiredState {
  return {
    desiredStateId: "ds_w97_v1",
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

let projectId: string;

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
  await deleteObservationsForProject(projectId);
  await deleteDesiredStatesForProject(projectId);
  await createDesiredState(desiredState(projectId));
  // Drifted observation (image mismatch) so evaluation requests execution.
  await prisma.actualStateObservation.create({
    data: {
      observationId: "obs_w97_route_drift",
      projectId,
      workloadId: "default",
      source: "test-harness",
      // Fresh relative to the real clock: evaluation must see it as current,
      // not stale (stale-after is 5 minutes).
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
    await deleteExecutionJobsForProject(projectId);
    await deleteObservationsForProject(projectId);
    await deleteDesiredStatesForProject(projectId);
    await prisma.project.deleteMany({ where: { name: projectName } });
  } finally {
    await prisma.$disconnect();
  }
});

test("ROUTE: POST evaluate returns execution-requested with a pending job", async () => {
  const response = await POST(request({}), context(projectId));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.outcome, "execution-requested");
  assert.equal(body.data.job.status, "pending");
  assert.equal(body.data.job.jobType, "reconcile");
  assert.equal(body.data.job.projectId, projectId);
  assert.equal(body.data.job.workloadId, "default");
  assert.equal(body.data.job.desiredState.desiredStateId, "ds_w97_v1");
  assert.equal(body.data.comparison.outcome, "drift");
  // Recording a request is not an infrastructure change.
  assert.equal(body.data.job.status !== "succeeded", true);
});

test("ROUTE: repeated evaluate is idempotent (already-active, same job)", async () => {
  const first = await POST(request({}), context(projectId));
  const firstBody = await first.json();
  const jobId = firstBody.data.job.jobId;

  const second = await POST(request({}), context(projectId));
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.data.outcome, "already-active");
  assert.equal(secondBody.data.job.jobId, jobId);

  const total = await prisma.executionJob.count({ where: { projectId } });
  assert.equal(total, 1);
});

test("ROUTE: client idempotency key is honored across requests", async () => {
  const first = await POST(
    request({ idempotencyKey: "w97-route-key" }),
    context(projectId)
  );
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const jobId =
    firstBody.data.outcome === "execution-requested"
      ? firstBody.data.job.jobId
      : firstBody.data.job.jobId;

  const replay = await POST(
    request({ idempotencyKey: "w97-route-key" }),
    context(projectId)
  );
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.data.job.jobId, jobId);
  assert.ok(
    replayBody.data.outcome === "already-active" ||
      replayBody.data.outcome === "already-recorded"
  );
});

test("ROUTE: workloadId and correlationId are accepted", async () => {
  const response = await POST(
    request({ workloadId: "route-wl", correlationId: "corr_w97" }),
    context(projectId)
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  // No observation for this workload → explicit safe outcome, no job.
  assert.equal(body.data.outcome, "observation-unavailable");
});

test("ROUTE: malformed JSON returns 400", async () => {
  const raw = new Request("http://test.local/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  }) as unknown as NextRequest;
  const response = await POST(raw, context(projectId));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("ROUTE: non-object body returns 400", async () => {
  const response = await POST(request([1, 2]), context(projectId));
  assert.equal(response.status, 400);
});

test("ROUTE: invalid field types return 400 with field errors", async () => {
  const response = await POST(
    request({ workloadId: 42, idempotencyKey: "" }),
    context(projectId)
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  const paths = body.errors.map((error: { path: string }) => error.path);
  assert.ok(paths.includes("workloadId"));
  assert.ok(paths.includes("idempotencyKey"));
});

test("ROUTE: unknown project returns 404", async () => {
  const response = await POST(request({}), context("prj_missing_w97"));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
});
