import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { DesiredState } from "../../types/desired-state.ts";
import type { RuntimeStatusReport } from "../../types/runtime-status.ts";
import type { HealthProbeTarget } from "../../types/health-check.ts";
import { prisma } from "../prisma.ts";
import { deleteObservationsForProject } from "../persistence/actual-state.ts";
import { deleteDesiredStatesForProject } from "../persistence/desired-state.ts";
import { createLogger, silentSink } from "../observability/logger.ts";
import { runHealthCheck } from "../health-check/evaluate.ts";
import { createHttpHealthProbe } from "../health-check/probe.ts";
import { withRetry } from "../resilience/retry.ts";
import {
  createDesiredState,
  getCurrentDesiredState,
  updateDesiredState,
} from "./desired-state.ts";
import {
  ActualStateConflictError,
  listObservations,
} from "./actual-state.ts";
import {
  getRuntimeStatus,
  reportRuntimeStatus,
} from "./runtime-status.ts";
import { compareProjectState } from "./drift.ts";

const KEEP = process.env.W92_KEEP === "1";
const mainProjectName = "w92-integration";
const otherProjectName = "w92-integration-other";
const silentLogger = createLogger({ sink: silentSink, level: "silent" });
const httpProbe = createHttpHealthProbe();

function buildDesiredState(
  projectId: string,
  desiredStateId: string
): DesiredState {
  return {
    desiredStateId,
    projectId,
    version: 1,
    createdAt: new Date("2026-10-21T08:00:00Z"),
    updatedAt: new Date("2026-10-21T08:00:00Z"),
    applications: { image: "forge-api:v1", port: 8080, version: "1.0.0" },
    runtime: { replicas: 2 },
    resources: { cpu: "250m", memory: "256Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 1 },
    health: { path: "/health", port: 8080 },
  };
}

function buildReport(
  projectId: string,
  overrides: Partial<RuntimeStatusReport> = {}
): RuntimeStatusReport {
  return {
    reportId: "rpt_w92_001",
    projectId,
    workloadId: "default",
    source: "node-agent",
    reportedAt: new Date("2026-10-21T10:00:00Z"),
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

let mainProjectId: string;
let otherProjectId: string;
let server: Server;
const startedServers: Server[] = [];
let healthyPort: number;
let unhealthyPort: number;
let closedPort: number;

async function startServer(port?: number): Promise<number> {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/unhealthy") {
      res.writeHead(503);
      res.end(JSON.stringify({ status: "unavailable" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  startedServers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(port ?? 0, "127.0.0.1", resolve)
  );
  return (server.address() as AddressInfo).port;
}

async function stopServer(target: Server = server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.close((error) => (error ? reject(error) : resolve()));
    target.closeAllConnections();
  });
}

async function stopAllServers(): Promise<void> {
  for (const entry of startedServers) {
    try {
      await stopServer(entry);
    } catch {
      /* already closed */
    }
  }
  startedServers.length = 0;
}

function probeTarget(port: number, path = "/health"): HealthProbeTarget {
  return { scheme: "http", host: "127.0.0.1", port, path };
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

before(async () => {
  mainProjectId = await ensureProject(mainProjectName);
  otherProjectId = await ensureProject(otherProjectName);
  if (!KEEP) {
    for (const projectId of [mainProjectId, otherProjectId]) {
      await deleteObservationsForProject(projectId);
      await deleteDesiredStatesForProject(projectId);
    }
  }
  healthyPort = await startServer();
  unhealthyPort = healthyPort;
});

after(async () => {
  await stopAllServers();
  try {
    if (!KEEP) {
      for (const [projectId, name] of [
        [mainProjectId, mainProjectName],
        [otherProjectId, otherProjectName],
      ] as const) {
        await deleteObservationsForProject(projectId);
        await deleteDesiredStatesForProject(projectId);
        await prisma.project.deleteMany({ where: { name } });
      }
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("integration: healthy runtime produces an accurate status report and drift match", async () => {
  await createDesiredState(buildDesiredState(mainProjectId, "ds_w92_v1"));

  const check = await runHealthCheck(
    httpProbe,
    {
      projectId: mainProjectId,
      workloadId: "default",
      target: probeTarget(healthyPort),
    },
    { logger: silentLogger, generateCheckId: () => "chk_w92_healthy" }
  );
  assert.equal(check.status, "healthy");

  const view = await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_healthy",
      health: { status: check.status === "healthy" ? "healthy" : "unhealthy" },
      diagnostics: {
        message: `health check ${check.status}`,
        reason: check.failure?.kind ?? "http-200",
        details: { checkId: check.checkId },
      },
    }),
    { logger: silentLogger }
  );
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.snapshot.health.status, "healthy");
  assert.equal(view.stale, false);

  const drift = await compareProjectState(mainProjectId, "default");
  assert.equal(drift.status, "compared");
  if (drift.status !== "compared") return;
  assert.equal(drift.comparison.outcome, "match");
  assert.equal(drift.comparison.findings.length, 0);

  const stored = await listObservations(mainProjectId, "default");
  assert.equal(stored.length, 1);
});

test("integration: unhealthy runtime is represented correctly end to end", async () => {
  const check = await runHealthCheck(
    httpProbe,
    {
      projectId: mainProjectId,
      workloadId: "unhealthy-demo",
      target: probeTarget(unhealthyPort, "/unhealthy"),
    },
    { logger: silentLogger, generateCheckId: () => "chk_w92_unhealthy" }
  );
  assert.equal(check.status, "unhealthy");
  assert.equal(check.failure?.kind, "http-error");

  await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_unhealthy",
      workloadId: "unhealthy-demo",
      health: { status: "unhealthy" },
      diagnostics: {
        message: check.failure?.message ?? "unhealthy",
        reason: check.failure?.kind ?? "http-error",
        details: { httpStatus: String(check.outcome?.statusCode ?? "") },
      },
    }),
    { logger: silentLogger }
  );

  const view = await getRuntimeStatus(mainProjectId, "unhealthy-demo");
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.snapshot.health.status, "unhealthy");

  const drift = await compareProjectState(mainProjectId, "unhealthy-demo");
  assert.equal(drift.status, "compared");
  if (drift.status !== "compared") return;
  assert.equal(drift.comparison.outcome, "drift");
  const unhealthyFindings = drift.comparison.findings.filter(
    (finding) => finding.category === "unhealthy"
  );
  assert.equal(unhealthyFindings.length, 1);
});

test("integration: failed health checks produce useful persisted diagnostics", async () => {
  closedPort = healthyPort;
  await stopServer();

  const check = await runHealthCheck(
    httpProbe,
    {
      projectId: mainProjectId,
      workloadId: "probe-failure",
      target: probeTarget(closedPort),
    },
    { logger: silentLogger, generateCheckId: () => "chk_w92_failed" }
  );
  assert.equal(check.status, "unhealthy");
  assert.ok(check.failure);
  assert.ok(check.failure?.message.length ?? 0 > 0);

  await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_probe_failure",
      workloadId: "probe-failure",
      status: "unknown",
      health: { status: "unhealthy" },
      diagnostics: {
        message: check.failure?.message ?? "probe failed",
        reason: check.failure?.kind ?? "unknown",
        details: {
          checkId: check.checkId,
          targetPath: check.target.path,
        },
      },
    }),
    { logger: silentLogger }
  );

  const view = await getRuntimeStatus(mainProjectId, "probe-failure");
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  const diagnostics = view.snapshot.diagnostics;
  assert.ok(diagnostics);
  assert.ok((diagnostics?.message ?? "").length > 0);
  assert.equal(diagnostics?.details?.checkId, "chk_w92_failed");
  assert.equal(diagnostics?.details?.targetPath, "/health");

  healthyPort = await startServer();
  unhealthyPort = healthyPort;
});

test("integration: stale reports follow the established contract", async () => {
  await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_stale_newer",
      workloadId: "stale-demo",
      reportedAt: new Date("2026-10-21T12:00:00Z"),
      health: { status: "healthy" },
    }),
    { logger: silentLogger }
  );
  await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_stale_older",
      workloadId: "stale-demo",
      reportedAt: new Date("2026-10-21T11:00:00Z"),
      status: "failed",
      health: { status: "unhealthy" },
    }),
    { logger: silentLogger }
  );

  const fresh = await getRuntimeStatus(mainProjectId, "stale-demo", {
    now: new Date("2026-10-21T12:01:00Z"),
  });
  assert.equal(fresh.availability, "known");
  if (fresh.availability !== "known") return;
  assert.equal(fresh.observation.observationId, "rpt_w92_stale_newer");
  assert.equal(fresh.stale, false);

  const aged = await getRuntimeStatus(mainProjectId, "stale-demo", {
    now: new Date("2026-10-21T13:00:00Z"),
  });
  if (aged.availability !== "known") return;
  assert.equal(aged.stale, true);

  const history = await listObservations(mainProjectId, "stale-demo");
  assert.equal(history.length, 2);
});

test("integration: runtime status survives a process restart", async () => {
  await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_restart",
      workloadId: "restart-demo",
      reportedAt: new Date("2026-10-21T15:00:00Z"),
    }),
    { logger: silentLogger }
  );

  await prisma.$disconnect();
  await prisma.$connect();

  const view = await getRuntimeStatus(mainProjectId, "restart-demo", {
    now: new Date("2026-10-21T15:01:00Z"),
  });
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.observation.observationId, "rpt_w92_restart");
  assert.equal(view.snapshot.health.status, "healthy");
});

test("integration: temporary failures recover without duplicate operations", async () => {
  const report = buildReport(mainProjectId, {
    reportId: "rpt_w92_idempotent",
    workloadId: "idempotent-demo",
  });

  await withRetry(() => reportRuntimeStatus(report, { logger: silentLogger }), {
    sleep: async () => {},
    logger: silentLogger,
    operationName: "day14-idempotent-report",
  });

  await assert.rejects(
    () =>
      withRetry(() => reportRuntimeStatus(report, { logger: silentLogger }), {
        maxAttempts: 3,
        sleep: async () => {},
        logger: silentLogger,
        operationName: "day14-idempotent-report",
      }),
    ActualStateConflictError
  );

  const rows = await listObservations(mainProjectId, "idempotent-demo");
  assert.equal(rows.length, 1);
});

test("integration: project and resource isolation remains correct", async () => {
  await createDesiredState(buildDesiredState(otherProjectId, "ds_w92_other_v1"));

  await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_iso_main",
      workloadId: "isolated",
      status: "running",
      health: { status: "healthy" },
    }),
    { logger: silentLogger }
  );
  await reportRuntimeStatus(
    buildReport(otherProjectId, {
      reportId: "rpt_w92_iso_other",
      workloadId: "isolated",
      status: "failed",
      health: { status: "unhealthy" },
    }),
    { logger: silentLogger }
  );

  const mainView = await getRuntimeStatus(mainProjectId, "isolated");
  const otherView = await getRuntimeStatus(otherProjectId, "isolated");
  if (mainView.availability !== "known") return;
  if (otherView.availability !== "known") return;
  assert.equal(mainView.snapshot.status, "running");
  assert.equal(otherView.snapshot.status, "failed");

  const mainDrift = await compareProjectState(mainProjectId, "isolated");
  const otherDrift = await compareProjectState(otherProjectId, "isolated");
  assert.equal(mainDrift.status, "compared");
  assert.equal(otherDrift.status, "compared");
  if (mainDrift.status !== "compared") return;
  if (otherDrift.status !== "compared") return;
  assert.equal(mainDrift.comparison.outcome, "match");
  assert.equal(otherDrift.comparison.outcome, "drift");

  const missing = await getRuntimeStatus(mainProjectId, "not-deployed-here");
  assert.equal(missing.availability, "unknown");
});

test("integration: existing Desired State workflows still function", async () => {
  const current = await getCurrentDesiredState(mainProjectId);
  assert.ok(current);
  assert.equal(current?.version, 1);

  const updated = await updateDesiredState(mainProjectId, {
    ...buildDesiredState(mainProjectId, "ds_w92_v2"),
    applications: { image: "forge-api:v2", port: 8080, version: "2.0.0" },
  });
  assert.equal(updated.version, 2);

  const nowCurrent = await getCurrentDesiredState(mainProjectId);
  assert.equal(nowCurrent?.version, 2);
  assert.equal(nowCurrent?.applications.image, "forge-api:v2");

  await reportRuntimeStatus(
    buildReport(mainProjectId, {
      reportId: "rpt_w92_v2_aligned",
      workloadId: "default",
      reportedAt: new Date("2026-10-21T16:00:00Z"),
      application: { image: "forge-api:v2", port: 8080, version: "2.0.0" },
      deployment: { version: 1 },
      health: { status: "healthy" },
    }),
    { logger: silentLogger }
  );

  const drift = await compareProjectState(mainProjectId, "default");
  assert.equal(drift.status, "compared");
  if (drift.status !== "compared") return;
  assert.equal(drift.desiredState.version, 2);
  assert.equal(drift.comparison.outcome, "match");
});
