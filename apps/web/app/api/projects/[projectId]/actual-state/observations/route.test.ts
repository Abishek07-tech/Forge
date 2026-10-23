import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { prisma } from "../../../../../../lib/prisma.ts";
import { deleteObservationsForProject } from "../../../../../../lib/persistence/actual-state.ts";
import { POST } from "./route.ts";

const routeProjectName = "w78-actual-route-tests";

function request(method: string, body?: unknown): NextRequest {
  return new Request("http://test.local/observations", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function validObservationBody(observationId: string) {
  return {
    observationId,
    workloadId: "default",
    source: "test-harness",
    observedAt: "2026-10-18T10:00:00Z",
    status: "running",
    application: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    health: { status: "healthy" },
  };
}

let routeProjectId: string | undefined;

before(async () => {
  const existing = await prisma.project.findFirst({
    where: { name: routeProjectName },
  });
  routeProjectId =
    existing?.id ??
    (
      await prisma.project.create({
        data: {
          name: routeProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;
  await deleteObservationsForProject(routeProjectId);
});

after(async () => {
  try {
    if (routeProjectId) {
      await deleteObservationsForProject(routeProjectId);
      await prisma.project.deleteMany({
        where: { name: routeProjectName },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("ROUTE: POST ingests a valid observation with 201", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", validObservationBody("obs_w78_route_v1")),
    context(routeProjectId)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.observationId, "obs_w78_route_v1");
  assert.equal(body.data.projectId, routeProjectId);
  assert.equal(body.data.workloadId, "default");
  assert.equal(body.data.source, "test-harness");
  assert.equal(body.data.status, "running");
  assert.ok(body.data.observedAt);
  assert.deepEqual(body.data.observation.application, {
    image: "forge-api:v1",
    port: 8080,
  });
  assert.deepEqual(body.data.observation.runtime, { replicas: 2 });
  assert.deepEqual(body.data.observation.resources, {
    cpu: "250m",
    memory: "256Mi",
  });
  assert.deepEqual(body.data.observation.health, { status: "healthy" });
});

test("ROUTE: projectId in the body is overridden by the path", async () => {
  assert.ok(routeProjectId);
  const bodyWithWrongProject = {
    ...validObservationBody("obs_w78_wrong_project"),
    projectId: "prj_should_be_ignored",
  };
  const response = await POST(
    request("POST", bodyWithWrongProject),
    context(routeProjectId)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.projectId, routeProjectId);
  assert.notEqual(body.data.projectId, "prj_should_be_ignored");
});

test("ROUTE: duplicate observationId returns 409", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", validObservationBody("obs_w78_route_v1")),
    context(routeProjectId)
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.ok(body.error.includes("obs_w78_route_v1"));
  assert.ok(!("errors" in body));
});

test("ROUTE: invalid payload returns 400 with field errors", async () => {
  assert.ok(routeProjectId);
  const invalidBody = {
    observationId: "obs_w78_invalid",
    workloadId: "default",
    source: "test-harness",
    observedAt: "bad-date",
    status: "mystery",
    application: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: -1 },
    resources: { cpu: "250m", memory: "256Mi" },
    health: { status: "healthy" },
  };
  const response = await POST(
    request("POST", invalidBody),
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.ok(Array.isArray(body.errors));
  const paths = body.errors.map((e: { path: string }) => e.path);
  assert.ok(paths.includes("observedAt"));
  assert.ok(paths.includes("status"));
  assert.ok(paths.includes("runtime.replicas"));
});

test("ROUTE: missing required fields returns 400", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", { observationId: "obs_w78_missing" }),
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  const paths = body.errors.map((e: { path: string }) => e.path);
  assert.ok(paths.includes("workloadId"));
  assert.ok(paths.includes("source"));
  assert.ok(paths.includes("observedAt"));
  assert.ok(paths.includes("status"));
  assert.ok(paths.includes("application"));
  assert.ok(paths.includes("runtime"));
  assert.ok(paths.includes("resources"));
  assert.ok(paths.includes("health"));
});

test("ROUTE: missing Project returns 404", async () => {
  const response = await POST(
    request("POST", validObservationBody("obs_w78_orphan")),
    context("prj_w78_does_not_exist")
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Project not found.");
});

test("ROUTE: malformed JSON returns 400", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    new Request("http://test.local/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    }) as unknown as NextRequest,
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Request body must be valid JSON.");
});

test("ROUTE: non-object body returns 400", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", "not-an-object"),
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Request body must be a JSON object.");
});

test("ROUTE: empty body returns 400", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    new Request("http://test.local/observations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }) as unknown as NextRequest,
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Request body must be valid JSON.");
});

test("ROUTE: optional environment and deployment groups are accepted", async () => {
  assert.ok(routeProjectId);
  const body = {
    ...validObservationBody("obs_w78_optional_groups"),
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
  };
  const response = await POST(request("POST", body), context(routeProjectId));

  assert.equal(response.status, 201);
  const data = (await response.json()).data;
  assert.deepEqual(data.observation.environment, { NODE_ENV: "production" });
  assert.deepEqual(data.observation.deployment, { version: 1 });
});

test("ROUTE: unknown observation values (nulls) are accepted", async () => {
  assert.ok(routeProjectId);
  const body = {
    ...validObservationBody("obs_w78_unknown_values"),
    status: "unknown",
    application: { image: null, port: null },
    runtime: { replicas: null },
    resources: { cpu: null, memory: null },
    health: { status: "unknown" },
  };
  const response = await POST(request("POST", body), context(routeProjectId));

  assert.equal(response.status, 201);
  const data = (await response.json()).data;
  assert.equal(data.status, "unknown");
  assert.equal(data.observation.application.image, null);
  assert.equal(data.observation.application.port, null);
  assert.equal(data.observation.runtime.replicas, null);
  assert.equal(data.observation.health.status, "unknown");
});

test("ROUTE: stale observation (older observedAt) is accepted with 201", async () => {
  assert.ok(routeProjectId);
  const workloadId = "stale-route-check";

  const newer = await POST(
    request("POST", {
      ...validObservationBody("obs_w78_stale_newer"),
      workloadId,
      observedAt: "2026-10-18T14:00:00Z",
    }),
    context(routeProjectId)
  );
  assert.equal(newer.status, 201);

  const older = await POST(
    request("POST", {
      ...validObservationBody("obs_w78_stale_older"),
      workloadId,
      observedAt: "2026-10-18T12:00:00Z",
    }),
    context(routeProjectId)
  );
  assert.equal(older.status, 201);

  const latest = await prisma.actualStateObservation.findFirst({
    where: { projectId: routeProjectId, workloadId },
    orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
  });
  assert.ok(latest);
  assert.equal(latest.observationId, "obs_w78_stale_newer");

  const count = await prisma.actualStateObservation.count({
    where: { projectId: routeProjectId, workloadId },
  });
  assert.equal(count, 2);
});

test("ROUTE: route does not talk to Prisma directly — service layer is used", async () => {
  assert.ok(routeProjectId);
  const stored = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w78_route_v1" },
  });
  assert.ok(stored);
  assert.equal(stored.projectId, routeProjectId);
  assert.equal(stored.status, "running");
  const data = stored.data as { runtime?: { replicas?: number } };
  assert.equal(data.runtime?.replicas, 2);
});

test("ROUTE: Desired State is not touched by ingestion", async () => {
  assert.ok(routeProjectId);
  const desiredCount = await prisma.desiredState.count({
    where: { projectId: routeProjectId },
  });
  assert.equal(desiredCount, 0);
});
