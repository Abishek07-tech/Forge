import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { prisma } from "../../../../../lib/prisma.ts";
import { deleteDesiredStatesForProject } from "../../../../../lib/persistence/desired-state.ts";
import { GET, POST, PUT } from "./route.ts";
import { GET as GET_VERSION } from "./[version]/route.ts";
import * as collectionRoute from "./route.ts";

const execFileAsync = promisify(execFile);

const e2eProjectName = "w68-e2e-desired-state";
const otherProjectName = "w68-e2e-other-project";

function request(method: string, body?: unknown): NextRequest {
  return new Request("http://test.local/desired-state", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

function context(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function versionContext(projectId: string, version: string) {
  return { params: Promise.resolve({ projectId, version }) };
}

function declaration(desiredStateId: string, overrides: Record<string, unknown> = {}) {
  return {
    desiredStateId,
    version: 1,
    applications: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
    health: { path: "/health" },
    ...overrides,
  };
}

async function createProject(name: string): Promise<string> {
  const existing = await prisma.project.findFirst({ where: { name } });
  if (existing) {
    await deleteDesiredStatesForProject(existing.id);
    return existing.id;
  }
  const created = await prisma.project.create({
    data: { name, status: "stopped", deployments: 0 },
  });
  return created.id;
}

let e2eProjectId: string | undefined;
let otherProjectId: string | undefined;

before(async () => {
  e2eProjectId = await createProject(e2eProjectName);
  otherProjectId = await createProject(otherProjectName);
});

after(async () => {
  try {
    if (e2eProjectId) await deleteDesiredStatesForProject(e2eProjectId);
    if (otherProjectId) await deleteDesiredStatesForProject(otherProjectId);
    await prisma.project.deleteMany({
      where: { name: { in: [e2eProjectName, otherProjectName] } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

test("E2E: full declare → read → version → update → history flow", async () => {
  assert.ok(e2eProjectId);

  const created = await POST(
    request("POST", declaration("ds_w68_v1")),
    context(e2eProjectId)
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.data.version, 1);

  const current = await GET(request("GET"), context(e2eProjectId));
  assert.equal(current.status, 200);
  const currentBody = await current.json();
  assert.equal(currentBody.data.desiredStateId, "ds_w68_v1");
  assert.equal(currentBody.data.version, 1);

  const updated = await PUT(
    request(
      "PUT",
      declaration("ds_w68_v2", {
        runtime: { replicas: 5 },
        applications: { image: "forge-api:v2", port: 9090 },
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(updated.status, 200);
  const updatedBody = await updated.json();
  assert.equal(updatedBody.data.version, 2);
  assert.equal(updatedBody.data.desiredStateId, "ds_w68_v2");

  const v1 = await GET_VERSION(request("GET"), versionContext(e2eProjectId, "1"));
  assert.equal(v1.status, 200);
  const v1Body = await v1.json();
  assert.equal(v1Body.data.desiredStateId, "ds_w68_v1");
  assert.deepEqual(v1Body.data.desiredState.runtime, { replicas: 2 });
  assert.deepEqual(v1Body.data.desiredState.applications, {
    image: "forge-api:v1",
    port: 8080,
  });

  const v2 = await GET_VERSION(request("GET"), versionContext(e2eProjectId, "2"));
  assert.equal(v2.status, 200);
  const v2Body = await v2.json();
  assert.deepEqual(v2Body.data.desiredState.runtime, { replicas: 5 });
});

test("E2E: stored rows match returned domain data exactly", async () => {
  assert.ok(e2eProjectId);
  const response = await GET(request("GET"), context(e2eProjectId));
  const body = await response.json();

  const row = await prisma.desiredState.findUnique({
    where: {
      projectId_version: { projectId: e2eProjectId, version: 2 },
    },
  });
  assert.ok(row);
  assert.equal(row.desiredStateId, body.data.desiredStateId);
  assert.equal(row.projectId, body.data.projectId);
  assert.equal(row.version, body.data.version);

  const payload = row.data as Record<string, unknown>;
  assert.deepEqual(payload.applications, body.data.desiredState.applications);
  assert.deepEqual(payload.runtime, body.data.desiredState.runtime);
  assert.deepEqual(payload.resources, body.data.desiredState.resources);
  assert.deepEqual(payload.environment, body.data.desiredState.environment);
  assert.deepEqual(payload.deployment, body.data.desiredState.deployment);
  assert.deepEqual(payload.health, body.data.desiredState.health);
});

test("E2E: project isolation — two projects never share state", async () => {
  assert.ok(e2eProjectId);
  assert.ok(otherProjectId);

  const otherCreated = await POST(
    request("POST", declaration("ds_w68_other_v1", { version: 1 })),
    context(otherProjectId)
  );
  assert.equal(otherCreated.status, 201);

  const otherCurrent = await GET(request("GET"), context(otherProjectId));
  const otherBody = await otherCurrent.json();
  assert.equal(otherBody.data.projectId, otherProjectId);
  assert.equal(otherBody.data.desiredStateId, "ds_w68_other_v1");

  const e2eCurrent = await GET(request("GET"), context(e2eProjectId));
  const e2eBody = await e2eCurrent.json();
  assert.equal(e2eBody.data.projectId, e2eProjectId);
  assert.equal(e2eBody.data.desiredStateId, "ds_w68_v2");

  const crossRead = await GET_VERSION(
    request("GET"),
    versionContext(otherProjectId, "2")
  );
  assert.equal(crossRead.status, 404);
});

test("E2E: invalid requests are rejected and persistence is unchanged", async () => {
  assert.ok(e2eProjectId);
  const before = await prisma.desiredState.count({
    where: { projectId: e2eProjectId },
  });

  const invalid = await POST(
    request("POST", {
      ...declaration("ds_w68_invalid"),
      runtime: { replicas: 0 },
    }),
    context(e2eProjectId)
  );
  assert.equal(invalid.status, 400);

  const malformed = await POST(
    new Request("http://test.local/desired-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{{{",
    }) as unknown as NextRequest,
    context(e2eProjectId)
  );
  assert.equal(malformed.status, 400);

  const after = await prisma.desiredState.count({
    where: { projectId: e2eProjectId },
  });
  assert.equal(after, before);
});

test("E2E: not-found and conflict responses are correct", async () => {
  assert.ok(e2eProjectId);

  const unknownProject = await GET(
    request("GET"),
    context("prj_w68_unknown")
  );
  assert.equal(unknownProject.status, 404);

  const missingVersion = await GET_VERSION(
    request("GET"),
    versionContext(e2eProjectId, "42")
  );
  assert.equal(missingVersion.status, 404);

  const conflict = await POST(
    request("POST", declaration("ds_w68_v2", { version: 3 })),
    context(e2eProjectId)
  );
  assert.equal(conflict.status, 409);
});

test("E2E: the contract exposes no retirement endpoint (documented gap)", () => {
  const routeModule = collectionRoute as Record<string, unknown>;
  assert.equal(routeModule.DELETE, undefined);
  assert.equal(routeModule.PATCH, undefined);
});

test("E2E: stored data survives a process restart", async () => {
  assert.ok(e2eProjectId);
  const script = `
    const { prisma } = await import("./lib/prisma.ts");
    const rows = await prisma.desiredState.findMany({
      where: { projectId: ${JSON.stringify(e2eProjectId)} },
      orderBy: { version: "asc" },
    });
    console.log(JSON.stringify(rows.map((r) => ({
      desiredStateId: r.desiredStateId,
      version: r.version,
      runtime: r.data.runtime,
    }))));
    await prisma.$disconnect();
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--env-file=.env", "--input-type=module", "-e", script],
    { cwd: process.cwd() }
  );
  const rows = JSON.parse(stdout.trim());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].desiredStateId, "ds_w68_v1");
  assert.deepEqual(rows[0].runtime, { replicas: 2 });
  assert.equal(rows[1].desiredStateId, "ds_w68_v2");
  assert.deepEqual(rows[1].runtime, { replicas: 5 });
});
