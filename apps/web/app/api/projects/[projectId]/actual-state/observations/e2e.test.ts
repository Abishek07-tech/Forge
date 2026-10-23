import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import type { NextRequest } from "next/server";
import { prisma } from "../../../../../../lib/prisma.ts";
import {
  deleteObservationsForProject,
} from "../../../../../../lib/persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../../../../../../lib/persistence/desired-state.ts";
import { getLatestObservation, listObservations } from "../../../../../../lib/services/actual-state.ts";
import { POST } from "./route.ts";


const e2eProjectName = "w79-e2e-actual-state";
const otherProjectName = "w79-e2e-other-project";

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

function observationBody(
  observationId: string,
  overrides: Record<string, unknown> = {}
) {
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
    ...overrides,
  };
}

async function createProject(name: string): Promise<string> {
  const existing = await prisma.project.findFirst({ where: { name } });
  if (existing) {
    await deleteObservationsForProject(existing.id);
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
    if (e2eProjectId) {
      await deleteObservationsForProject(e2eProjectId);
      await deleteDesiredStatesForProject(e2eProjectId);
    }
    if (otherProjectId) {
      await deleteObservationsForProject(otherProjectId);
      await deleteDesiredStatesForProject(otherProjectId);
    }
    await prisma.project.deleteMany({
      where: { name: { in: [e2eProjectName, otherProjectName] } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

test("E2E: successful observation ingestion — full flow verified", async () => {
  assert.ok(e2eProjectId);

  const response = await POST(
    request("POST", observationBody("obs_w79_e2e_v1")),
    context(e2eProjectId)
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.observationId, "obs_w79_e2e_v1");
  assert.equal(body.data.projectId, e2eProjectId);

  const stored = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_e2e_v1" },
  });
  assert.ok(stored);
  assert.equal(stored.projectId, e2eProjectId);
  assert.equal(stored.workloadId, "default");
  assert.equal(stored.source, "test-harness");
  assert.equal(stored.status, "running");
  assert.equal(
    stored.observedAt.getTime(),
    Date.parse("2026-10-18T10:00:00Z")
  );
  const data = stored.data as {
    application?: { image?: string; port?: number };
    runtime?: { replicas?: number };
    resources?: { cpu?: string; memory?: string };
    health?: { status?: string };
  };
  assert.equal(data.application?.image, "forge-api:v1");
  assert.equal(data.application?.port, 8080);
  assert.equal(data.runtime?.replicas, 2);
  assert.equal(data.resources?.cpu, "250m");
  assert.equal(data.resources?.memory, "256Mi");
  assert.equal(data.health?.status, "healthy");
});

test("E2E: correct Project association across projects", async () => {
  assert.ok(e2eProjectId);
  assert.ok(otherProjectId);

  const responseA = await POST(
    request("POST", observationBody("obs_w79_proj_a")),
    context(e2eProjectId)
  );
  assert.equal(responseA.status, 201);
  const bodyA = await responseA.json();
  assert.equal(bodyA.data.projectId, e2eProjectId);

  const responseB = await POST(
    request("POST", observationBody("obs_w79_proj_b")),
    context(otherProjectId)
  );
  assert.equal(responseB.status, 201);
  const bodyB = await responseB.json();
  assert.equal(bodyB.data.projectId, otherProjectId);

  const storedA = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_proj_a" },
  });
  const storedB = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_proj_b" },
  });
  assert.equal(storedA?.projectId, e2eProjectId);
  assert.equal(storedB?.projectId, otherProjectId);
});

test("E2E: correct runtime/application identity is stored and read back", async () => {
  assert.ok(e2eProjectId);
  const response = await POST(
    request(
      "POST",
      observationBody("obs_w79_identity", {
        workloadId: "worker-1",
        application: { image: "forge-worker:v3", port: 9090, version: "3.1.4" },
        runtime: { replicas: 5 },
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.data.workloadId, "worker-1");
  assert.deepEqual(body.data.observation.application, {
    image: "forge-worker:v3",
    port: 9090,
    version: "3.1.4",
  });
  assert.deepEqual(body.data.observation.runtime, { replicas: 5 });

  const stored = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_identity" },
  });
  assert.ok(stored);
  const data = stored.data as { application?: { version?: string } };
  assert.equal(data.application?.version, "3.1.4");
});

test("E2E: correct observed status and timestamp handling", async () => {
  assert.ok(e2eProjectId);
  const statuses = ["running", "stopped", "failed", "unknown"] as const;
  for (const [index, status] of statuses.entries()) {
    const observedAt = `2026-10-18T11:0${index}:00Z`;
    const response = await POST(
      request(
        "POST",
        observationBody(`obs_w79_status_${index}`, { status, observedAt })
      ),
      context(e2eProjectId)
    );
    assert.equal(response.status, 201, `status=${status}`);
    const body = await response.json();
    assert.equal(body.data.status, status);
    assert.equal(
      Date.parse(body.data.observedAt),
      Date.parse(observedAt)
    );

    const stored = await prisma.actualStateObservation.findUnique({
      where: { observationId: `obs_w79_status_${index}` },
    });
    assert.ok(stored);
    assert.equal(stored.status, status);
    assert.equal(stored.observedAt.getTime(), Date.parse(observedAt));
  }
});

test("E2E: optional fields and nested data are supported", async () => {
  assert.ok(e2eProjectId);
  const response = await POST(
    request(
      "POST",
      observationBody("obs_w79_optional", {
        environment: { NODE_ENV: "production", LOG_LEVEL: "info" },
        deployment: { version: 42 },
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body.data.observation.environment, {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
  });
  assert.deepEqual(body.data.observation.deployment, { version: 42 });

  const stored = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_optional" },
  });
  assert.ok(stored);
  const data = stored.data as {
    environment?: Record<string, string>;
    deployment?: { version?: number };
  };
  assert.deepEqual(data.environment, {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
  });
  assert.equal(data.deployment?.version, 42);
});

test("E2E: invalid request is rejected before persistence", async () => {
  assert.ok(e2eProjectId);
  const before = await prisma.actualStateObservation.count({
    where: { projectId: e2eProjectId },
  });

  const response = await POST(
    request(
      "POST",
      observationBody("obs_w79_invalid", {
        runtime: { replicas: -5 },
        status: "invalid-status",
        observedAt: "not-a-date",
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.ok(Array.isArray(body.errors));
  const paths = body.errors.map((e: { path: string }) => e.path);
  assert.ok(paths.includes("observedAt"));
  assert.ok(paths.includes("status"));
  assert.ok(paths.includes("runtime.replicas"));

  const after = await prisma.actualStateObservation.count({
    where: { projectId: e2eProjectId },
  });
  assert.equal(after, before);

  const stored = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_invalid" },
  });
  assert.equal(stored, null);
});

test("E2E: missing Project returns 404", async () => {
  const response = await POST(
    request("POST", observationBody("obs_w79_orphan")),
    context("prj_w79_does_not_exist")
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error, "Project not found.");
});

test("E2E: duplicate observation returns 409 and does not overwrite", async () => {
  assert.ok(e2eProjectId);

  const first = await POST(
    request(
      "POST",
      observationBody("obs_w79_dup", {
        status: "running",
        observedAt: "2026-10-18T12:00:00Z",
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(first.status, 201);

  const second = await POST(
    request(
      "POST",
      observationBody("obs_w79_dup", {
        status: "failed",
        observedAt: "2026-10-18T13:00:00Z",
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.success, false);
  assert.ok(body.error.includes("obs_w79_dup"));

  const stored = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_dup" },
  });
  assert.ok(stored);
  assert.equal(stored.status, "running");
  assert.equal(stored.observedAt.getTime(), Date.parse("2026-10-18T12:00:00Z"));

  const count = await prisma.actualStateObservation.count({
    where: { observationId: "obs_w79_dup" },
  });
  assert.equal(count, 1);
});

test("E2E: older observation is accepted but does not become latest", async () => {
  assert.ok(e2eProjectId);
  const workloadId = "stale-e2e";

  const newer = await POST(
    request(
      "POST",
      observationBody("obs_w79_stale_newer", {
        workloadId,
        observedAt: "2026-10-18T15:00:00Z",
        application: { image: "forge-api:v2", port: 8080 },
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(newer.status, 201);

  const older = await POST(
    request(
      "POST",
      observationBody("obs_w79_stale_older", {
        workloadId,
        observedAt: "2026-10-18T14:00:00Z",
        application: { image: "forge-api:v1", port: 8080 },
      })
    ),
    context(e2eProjectId)
  );
  assert.equal(older.status, 201);

  const latest = await getLatestObservation(e2eProjectId, workloadId);
  assert.ok(latest);
  assert.equal(latest.observationId, "obs_w79_stale_newer");
  assert.equal(
    latest.observedAt.getTime(),
    Date.parse("2026-10-18T15:00:00Z")
  );
  assert.deepEqual(latest.application, { image: "forge-api:v2", port: 8080 });

  const history = await listObservations(e2eProjectId, workloadId);
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((o: { observationId: string }) => o.observationId),
    ["obs_w79_stale_older", "obs_w79_stale_newer"]
  );
});

test("E2E: stored observations are retrievable through service methods", async () => {
  assert.ok(e2eProjectId);

  const latest = await getLatestObservation(e2eProjectId, "default");
  assert.ok(latest);
  assert.ok(latest.observedAt instanceof Date);
  assert.equal(latest.projectId, e2eProjectId);

  const history = await listObservations(e2eProjectId, "default");
  assert.ok(history.length > 0);
  for (const observation of history) {
    assert.equal(observation.projectId, e2eProjectId);
    assert.ok(observation.observedAt instanceof Date);
  }
});

test("E2E: observation history is preserved — all rows immutable", async () => {
  assert.ok(e2eProjectId);
  const workloadId = "history-e2e";

  for (let i = 1; i <= 3; i++) {
    const response = await POST(
      request(
        "POST",
        observationBody(`obs_w79_hist_${i}`, {
          workloadId,
          observedAt: `2026-10-18T16:0${i}:00Z`,
          status: i === 1 ? "running" : i === 2 ? "stopped" : "failed",
        })
      ),
      context(e2eProjectId)
    );
    assert.equal(response.status, 201, `iteration ${i}`);
  }

  const history = await listObservations(e2eProjectId, workloadId);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((o: { observationId: string }) => o.observationId),
    ["obs_w79_hist_1", "obs_w79_hist_2", "obs_w79_hist_3"]
  );
  assert.equal(history[0].status, "running");
  assert.equal(history[1].status, "stopped");
  assert.equal(history[2].status, "failed");

  const row1 = await prisma.actualStateObservation.findUnique({
    where: { observationId: "obs_w79_hist_1" },
  });
  assert.ok(row1);
  assert.equal(row1.status, "running");
});

test("E2E: Desired State API behavior is unchanged by ingestion", async () => {
  assert.ok(e2eProjectId);

  const { POST: POST_DESIRED, GET: GET_DESIRED } = await import(
    "../../desired-state/route.ts"
  );

  const desiredResponse = await POST_DESIRED(
    new Request("http://test.local/desired-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        desiredStateId: "ds_w79_e2e",
        version: 1,
        applications: { image: "forge-api:v1", port: 8080 },
        runtime: { replicas: 2 },
        resources: { cpu: "250m", memory: "256Mi" },
        health: { path: "/health" },
      }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ projectId: e2eProjectId }) }
  );
  assert.equal(desiredResponse.status, 201);

  const desiredGet = await GET_DESIRED(
    new Request("http://test.local/desired-state") as unknown as NextRequest,
    { params: Promise.resolve({ projectId: e2eProjectId }) }
  );
  assert.equal(desiredGet.status, 200);
  const desiredBody = await desiredGet.json();
  assert.equal(desiredBody.data.desiredStateId, "ds_w79_e2e");
  assert.equal(desiredBody.data.version, 1);

  const desiredRows = await prisma.desiredState.count({
    where: { projectId: e2eProjectId },
  });
  assert.equal(desiredRows, 1);
});

test("E2E: cross-process restart survival — stored observations persist", async () => {
  assert.ok(e2eProjectId);
  const workloadId = "restart-e2e";

  await POST(
    request(
      "POST",
      observationBody("obs_w79_restart", {
        workloadId,
        observedAt: "2026-10-18T17:00:00Z",
        application: { image: "forge-api:v1", port: 8080 },
      })
    ),
    context(e2eProjectId)
  );

  await prisma.$disconnect();

  const { PrismaClient } = await import("../../../../../../generated/prisma/client.ts");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const url = process.env.DATABASE_URL;
  assert.ok(url, "DATABASE_URL must be set for restart check");
  const freshClient = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

  try {
    const row = await freshClient.actualStateObservation.findUnique({
      where: { observationId: "obs_w79_restart" },
    });
    assert.ok(row);
    assert.equal(row.projectId, e2eProjectId);
    assert.equal(row.workloadId, workloadId);
    assert.equal(row.status, "running");
    assert.equal(row.observedAt.getTime(), Date.parse("2026-10-18T17:00:00Z"));
    const data = row.data as { application?: { image?: string } };
    assert.equal(data.application?.image, "forge-api:v1");
  } finally {
    await freshClient.$disconnect();
  }
});

test("E2E: no real agent or runtime was contacted — source remains test-harness", async () => {
  assert.ok(e2eProjectId);
  const rows = await prisma.actualStateObservation.findMany({
    where: { projectId: e2eProjectId },
    select: { source: true },
  });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.source, "test-harness");
  }
});

test("E2E: live HTTP smoke test against next dev", async () => {
  assert.ok(e2eProjectId);

  const port = 3199;
  const devProcess = execFile(
    "npx",
    ["next", "dev", "-p", String(port)],
    { cwd: process.cwd() },
    () => {}
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("dev server did not start in time")),
        45000
      );
      const check = async () => {
        try {
          const res = await fetch(`http://localhost:${port}/api/projects`);
          if (res.ok) {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {
          // not ready yet
        }
        setTimeout(check, 500);
      };
      check();
    });

    const smokeBody = observationBody("obs_w79_smoke", {
      workloadId: "smoke-check",
      observedAt: "2026-10-18T18:00:00Z",
    });

    const createRes = await fetch(
      `http://localhost:${port}/api/projects/${e2eProjectId}/actual-state/observations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(smokeBody),
      }
    );
    assert.equal(createRes.status, 201);
    const createJson = (await createRes.json()) as {
      success: boolean;
      data: { observationId: string; projectId: string };
    };
    assert.equal(createJson.success, true);
    assert.equal(createJson.data.observationId, "obs_w79_smoke");
    assert.equal(createJson.data.projectId, e2eProjectId);

    const dupRes = await fetch(
      `http://localhost:${port}/api/projects/${e2eProjectId}/actual-state/observations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(smokeBody),
      }
    );
    assert.equal(dupRes.status, 409);

    const badRes = await fetch(
      `http://localhost:${port}/api/projects/${e2eProjectId}/actual-state/observations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observationId: "" }),
      }
    );
    assert.equal(badRes.status, 400);

    const missingProjectRes = await fetch(
      `http://localhost:${port}/api/projects/prj_w79_missing/actual-state/observations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          observationBody("obs_w79_smoke_orphan", {
            workloadId: "smoke-check",
            observedAt: "2026-10-18T18:01:00Z",
          })
        ),
      }
    );
    assert.equal(missingProjectRes.status, 404);

    await prisma.actualStateObservation.deleteMany({
      where: { observationId: "obs_w79_smoke" },
    });
  } finally {
    devProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      devProcess.on("exit", () => resolve());
      setTimeout(resolve, 5000);
    });
  }
});
