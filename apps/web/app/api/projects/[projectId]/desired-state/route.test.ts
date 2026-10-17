import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/prisma.ts";
import { deleteDesiredStatesForProject } from "../../../../../lib/persistence/desired-state.ts";
import {
  DesiredStateNotFoundError,
  DesiredStateServiceError,
  DesiredStateValidationFailedError,
} from "../../../../../lib/services/desired-state.ts";
import { errorResponse } from "../../../../../lib/api/desired-state-http.ts";
import { GET, POST, PUT } from "./route.ts";
import { GET as GET_VERSION } from "./[version]/route.ts";

const routeProjectName = "w65-route-tests";

function request(
  method: string,
  body?: unknown
): NextRequest {
  return new Request("http://test.local/desired-state", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

function context(projectId: string) {
  return {
    params: Promise.resolve({ projectId }),
  };
}

function versionContext(projectId: string, version: string) {
  return {
    params: Promise.resolve({ projectId, version }),
  };
}

function validDeclaration(desiredStateId: string, replicas = 2) {
  return {
    desiredStateId,
    version: 1,
    applications: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas },
    resources: { cpu: "250m", memory: "256Mi" },
    health: { path: "/health" },
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
  await deleteDesiredStatesForProject(routeProjectId);
});

after(async () => {
  try {
    if (routeProjectId) {
      await deleteDesiredStatesForProject(routeProjectId);
      await prisma.project.deleteMany({
        where: { name: routeProjectName },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("ROUTE: POST creates the first Desired State with 201", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", validDeclaration("ds_w65_route_v1")),
    context(routeProjectId)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.desiredStateId, "ds_w65_route_v1");
  assert.equal(body.data.projectId, routeProjectId);
  assert.equal(body.data.version, 1);
  assert.deepEqual(body.data.desiredState.runtime, { replicas: 2 });
  assert.deepEqual(body.data.desiredState.applications, {
    image: "forge-api:v1",
    port: 8080,
  });
  assert.deepEqual(body.data.desiredState.health, { path: "/health" });
});

test("ROUTE: GET returns the current Desired State", async () => {
  assert.ok(routeProjectId);
  const response = await GET(request("GET"), context(routeProjectId));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.desiredStateId, "ds_w65_route_v1");
  assert.equal(body.data.version, 1);
});

test("ROUTE: PUT appends the next version", async () => {
  assert.ok(routeProjectId);
  const response = await PUT(
    request("PUT", {
      ...validDeclaration("ds_w65_route_v2", 4),
      applications: { image: "forge-api:v2", port: 9090 },
    }),
    context(routeProjectId)
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.desiredStateId, "ds_w65_route_v2");
  assert.equal(body.data.version, 2);
  assert.deepEqual(body.data.desiredState.runtime, { replicas: 4 });
});

test("ROUTE: GET specific version returns the historical snapshot", async () => {
  assert.ok(routeProjectId);
  const response = await GET_VERSION(
    request("GET"),
    versionContext(routeProjectId, "1")
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.desiredStateId, "ds_w65_route_v1");
  assert.equal(body.data.version, 1);
  assert.deepEqual(body.data.desiredState.runtime, { replicas: 2 });
});

test("ROUTE: projectId in the path scopes the declaration", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", {
      ...validDeclaration("ds_w65_route_wrong"),
      version: 3,
      projectId: "prj_w65_not_the_path_project",
    }),
    context(routeProjectId)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.projectId, routeProjectId);

  const stray = await prisma.desiredState.findFirst({
    where: { projectId: "prj_w65_not_the_path_project" },
  });
  assert.equal(stray, null);

  await prisma.desiredState.deleteMany({
    where: { desiredStateId: "ds_w65_route_wrong" },
  });
});

test("ROUTE: GET with no Desired State returns 404", async () => {
  const response = await GET(
    request("GET"),
    context("prj_w65_no_desired_state")
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("VALIDATION: missing required fields returns 400 with field errors", async () => {
  assert.ok(routeProjectId);
  const before = await prisma.desiredState.count({
    where: { projectId: routeProjectId },
  });

  const response = await POST(
    request("POST", { desiredStateId: "ds_w66_incomplete" }),
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Desired State failed validation.");
  const paths = body.errors.map(
    (e: { path: string }) => e.path
  );
  assert.ok(paths.includes("version"));
  assert.ok(paths.includes("applications"));
  assert.ok(paths.includes("runtime"));
  assert.ok(paths.includes("resources"));
  assert.ok(paths.includes("health"));

  const after = await prisma.desiredState.count({
    where: { projectId: routeProjectId },
  });
  assert.equal(after, before);
});

test("VALIDATION: invalid nested data returns 400 with nested paths", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", {
      ...validDeclaration("ds_w66_nested_invalid"),
      runtime: { replicas: 0 },
      applications: { image: "forge-api:v1", port: 99999 },
    }),
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  const paths = body.errors.map(
    (e: { path: string }) => e.path
  );
  assert.ok(paths.includes("runtime.replicas"));
  assert.ok(paths.includes("applications.port"));

  const stored = await prisma.desiredState.findFirst({
    where: { desiredStateId: "ds_w66_nested_invalid" },
  });
  assert.equal(stored, null);
});

test("VALIDATION: multiple errors are all reported", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", {
      desiredStateId: "",
      version: "not-a-number",
      runtime: { replicas: -1 },
    }),
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.ok(body.errors.length >= 4);
});

test("VALIDATION: malformed JSON returns 400", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    new Request("http://test.local/desired-state", {
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

test("VALIDATION: non-object bodies return 400", async () => {
  assert.ok(routeProjectId);
  for (const payload of ["a string", 42, [1, 2, 3]]) {
    const response = await POST(
      new Request("http://test.local/desired-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }) as unknown as NextRequest,
      context(routeProjectId)
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "Request body must be a JSON object.");
  }

  const nullResponse = await POST(
    new Request("http://test.local/desired-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    }) as unknown as NextRequest,
    context(routeProjectId)
  );
  assert.equal(nullResponse.status, 400);
});

test("VALIDATION: invalid version path params return 400", async () => {
  assert.ok(routeProjectId);
  for (const bad of ["abc", "0", "-1", "1.5", ""]) {
    const response = await GET_VERSION(
      request("GET"),
      versionContext(routeProjectId, bad)
    );
    assert.equal(response.status, 400, `version=${bad}`);
  }
});

test("VALIDATION: invalid PUT cannot create a new version", async () => {
  assert.ok(routeProjectId);
  const before = await prisma.desiredState.count({
    where: { projectId: routeProjectId },
  });

  const response = await PUT(
    request("PUT", {
      ...validDeclaration("ds_w66_invalid_put"),
      resources: { cpu: "", memory: "" },
    }),
    context(routeProjectId)
  );

  assert.equal(response.status, 400);
  const after = await prisma.desiredState.count({
    where: { projectId: routeProjectId },
  });
  assert.equal(after, before);
});

test("VALIDATION: duplicate version returns 409 and stores nothing new", async () => {
  assert.ok(routeProjectId);
  const before = await prisma.desiredState.count({
    where: { projectId: routeProjectId },
  });

  const response = await POST(
    request("POST", validDeclaration("ds_w66_dup_version", 1)),
    context(routeProjectId)
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.success, false);
  const after = await prisma.desiredState.count({
    where: { projectId: routeProjectId },
  });
  assert.equal(after, before);
});

test("ERRORS: POST for an unknown project returns 404", async () => {
  const response = await POST(
    request("POST", validDeclaration("ds_w67_orphan")),
    context("prj_w67_does_not_exist")
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Project not found.");

  const stored = await prisma.desiredState.findFirst({
    where: { desiredStateId: "ds_w67_orphan" },
  });
  assert.equal(stored, null);
});

test("ERRORS: PUT for a project with no Desired State returns 404", async () => {
  const response = await PUT(
    request("PUT", validDeclaration("ds_w67_put_missing")),
    context("prj_w67_no_desired_state")
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("ERRORS: GET for a missing version returns 404", async () => {
  assert.ok(routeProjectId);
  const response = await GET_VERSION(
    request("GET"),
    versionContext(routeProjectId, "999")
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.ok(body.error.includes("999"));
});

test("ERRORS: duplicate desiredStateId returns 409", async () => {
  assert.ok(routeProjectId);
  const response = await POST(
    request("POST", {
      ...validDeclaration("ds_w65_route_v1", 3),
      version: 5,
    }),
    context(routeProjectId)
  );

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.success, false);
});

test("ERRORS: unexpected errors map to a safe 500 without leaking details", async () => {
  const leaky = new Error("prisma connection string postgres://user:secret@host");
  const response = errorResponse(leaky);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Internal server error.");
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("secret"));
  assert.ok(!raw.includes("prisma"));
  assert.ok(!raw.includes("postgres://"));
  assert.ok(!("stack" in body));
});

test("ERRORS: persistence failures map to 500, not 4xx", async () => {
  const failure = new DesiredStateServiceError(
    "PERSISTENCE_FAILED",
    "Failed to persist Desired State."
  );
  const response = errorResponse(failure);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "Internal server error.");
});

test("ERRORS: service errors map to the documented status codes", async () => {
  const validation = errorResponse(
    new DesiredStateValidationFailedError([
      { path: "version", message: "version is required" },
    ])
  );
  assert.equal(validation.status, 400);

  const notFound = errorResponse(new DesiredStateNotFoundError());
  assert.equal(notFound.status, 404);
});
