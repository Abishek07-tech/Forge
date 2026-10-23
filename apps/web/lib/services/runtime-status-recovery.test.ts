import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { RuntimeStatusReport } from "../../types/runtime-status.ts";
import type { HealthProbeTarget } from "../../types/health-check.ts";
import { prisma } from "../prisma.ts";
import {
  deleteObservationsForProject,
} from "../persistence/actual-state.ts";
import { createLogger, silentSink } from "../observability/logger.ts";
import { runHealthCheck } from "../health-check/evaluate.ts";
import { createHttpHealthProbe } from "../health-check/probe.ts";
import { withRetry, RetryExhaustedError } from "../resilience/retry.ts";
import {
  ActualStateConflictError,
  getLatestObservation,
  listObservations,
} from "./actual-state.ts";
import {
  getRuntimeStatus,
  reportRuntimeStatus,
} from "./runtime-status.ts";

const KEEP = process.env.W91_KEEP === "1";
const recoveryProjectName = "w91-recovery";
const silentLogger = createLogger({ sink: silentSink, level: "silent" });
const httpProbe = createHttpHealthProbe();

function buildReport(
  overrides: Partial<RuntimeStatusReport> = {}
): RuntimeStatusReport {
  return {
    reportId: "rpt_w91_001",
    projectId: "prj_w91_placeholder",
    workloadId: "default",
    source: "node-agent",
    reportedAt: new Date("2026-10-21T10:00:00Z"),
    status: "running",
    application: { image: "forge-api:v1", port: 8080 },
    runtime: { replicas: 1 },
    resources: { cpu: "250m", memory: "256Mi" },
    health: { status: "healthy" },
    ...overrides,
  };
}

let recoveryProjectId: string;
let server: Server;
let serverPort: number;

function target(): HealthProbeTarget {
  return {
    scheme: "http",
    host: "127.0.0.1",
    port: serverPort,
    path: "/health",
  };
}

async function startServer(port?: number): Promise<number> {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) =>
    server.listen(port ?? 0, "127.0.0.1", resolve)
  );
  return (server.address() as AddressInfo).port;
}

async function stopServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

before(async () => {
  const existing = await prisma.project.findFirst({
    where: { name: recoveryProjectName },
  });
  recoveryProjectId =
    existing?.id ??
    (
      await prisma.project.create({
        data: { name: recoveryProjectName, status: "stopped", deployments: 0 },
      })
    ).id;
  if (!KEEP) {
    await deleteObservationsForProject(recoveryProjectId);
  }
  serverPort = await startServer();
});

after(async () => {
  try {
    if (server) {
      await stopServer();
    }
  } catch {
    /* server may already be closed by a test */
  }
  try {
    if (!KEEP && recoveryProjectId) {
      await deleteObservationsForProject(recoveryProjectId);
      await prisma.project.deleteMany({
        where: { name: recoveryProjectName },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("recovery: runtime status written before a restart is readable after reconnect", async () => {
  const workloadId = "restart-recovery";
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w91_restart",
      projectId: recoveryProjectId,
      workloadId,
      reportedAt: new Date("2026-10-21T09:30:00Z"),
      status: "running",
      health: { status: "healthy" },
      diagnostics: { message: "pre-restart snapshot" },
    }),
    { logger: silentLogger }
  );

  await prisma.$disconnect();

  const { PrismaClient } = await import("../../generated/prisma/client.ts");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const url = process.env.DATABASE_URL;
  assert.ok(url, "DATABASE_URL must be set for the restart check");
  const freshClient = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
    const row = await freshClient.actualStateObservation.findUnique({
      where: { observationId: "rpt_w91_restart" },
    });
    assert.ok(row, "a fresh process must see the persisted observation");
    assert.equal(row.projectId, recoveryProjectId);
    assert.equal(row.status, "running");
    const data = row.data as {
      diagnostics?: { message?: string };
    };
    assert.equal(data.diagnostics?.message, "pre-restart snapshot");
  } finally {
    await freshClient.$disconnect();
  }

  await prisma.$connect();
  const view = await getRuntimeStatus(recoveryProjectId, workloadId, {
    now: new Date("2026-10-21T09:35:00Z"),
  });
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.observation.observationId, "rpt_w91_restart");
  assert.equal(view.stale, false);
});

test("recovery: stale health information after a restart is reported as stale, never fresh", async () => {
  const view = await getRuntimeStatus(recoveryProjectId, "restart-recovery", {
    now: new Date("2026-10-21T18:00:00Z"),
    staleAfterMs: 5 * 60 * 1000,
  });
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.stale, true);
  assert.ok(view.ageMs > 5 * 60 * 1000);
  assert.equal(view.snapshot.health.status, "healthy");
  assert.equal(view.stale, true);
});

test("recovery: temporary connectivity loss is recovered and reported without duplicates", async () => {
  const workloadId = "connectivity-recovery";
  const originalPort = serverPort;

  const beforeCheck = await runHealthCheck(
    httpProbe,
    { projectId: recoveryProjectId, workloadId, target: target() },
    { logger: silentLogger, generateCheckId: () => "chk_w91_before_outage" }
  );
  assert.equal(beforeCheck.status, "healthy");

  await stopServer();

  const duringCheck = await runHealthCheck(
    httpProbe,
    { projectId: recoveryProjectId, workloadId, target: target() },
    { logger: silentLogger, generateCheckId: () => "chk_w91_during_outage" }
  );
  assert.equal(duringCheck.status, "unhealthy");

  serverPort = await startServer(originalPort);

  const afterCheck = await runHealthCheck(
    httpProbe,
    { projectId: recoveryProjectId, workloadId, target: target() },
    { logger: silentLogger, generateCheckId: () => "chk_w91_after_recovery" }
  );
  assert.equal(afterCheck.status, "healthy");

  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w91_outage_unhealthy",
      projectId: recoveryProjectId,
      workloadId,
      reportedAt: new Date("2026-10-21T14:00:00Z"),
      status: "unknown",
      health: { status: "unhealthy" },
      diagnostics: {
        message: duringCheck.failure?.message ?? "probe failed",
        reason: duringCheck.failure?.kind ?? "unknown",
      },
    }),
    { logger: silentLogger }
  );
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w91_outage_recovered",
      projectId: recoveryProjectId,
      workloadId,
      reportedAt: new Date("2026-10-21T14:05:00Z"),
      status: "running",
      health: { status: "healthy" },
      diagnostics: { message: "probe recovered after outage" },
    }),
    { logger: silentLogger }
  );

  const view = await getRuntimeStatus(recoveryProjectId, workloadId, {
    now: new Date("2026-10-21T14:05:30Z"),
  });
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.snapshot.health.status, "healthy");
  assert.equal(view.observation.observationId, "rpt_w91_outage_recovered");

  const rows = await listObservations(recoveryProjectId, workloadId);
  assert.equal(rows.length, 2);
});

test("recovery: a retry loop spanning an outage succeeds once the target returns", async () => {
  const workloadId = "retry-across-outage";
  const originalPort = serverPort;
  await stopServer();

  let recovered = false;
  const result = await withRetry(
    async (attempt) => {
      if (attempt === 2) {
        serverPort = await startServer(originalPort);
        recovered = true;
      }
      const check = await runHealthCheck(
        httpProbe,
        { projectId: recoveryProjectId, workloadId, target: target() },
        { logger: silentLogger }
      );
      if (check.status !== "healthy") {
        throw new Error("transient: runtime unreachable");
      }
      return check;
    },
    {
      maxAttempts: 4,
      sleep: async () => {},
      logger: silentLogger,
      operationName: "health-probe-across-outage",
    }
  );

  assert.equal(result.status, "healthy");
  assert.equal(recovered, true);

  const exhausted = await withRetry(
    async () => {
      throw new Error("transient: still unreachable");
    },
    {
      maxAttempts: 2,
      sleep: async () => {},
      logger: silentLogger,
      operationName: "unrecoverable-demo",
    }
  ).then(
    () => null,
    (error: unknown) => error
  );
  assert.ok(exhausted instanceof RetryExhaustedError);
});

test("recovery: resuming an interrupted report does not duplicate the observation", async () => {
  const workloadId = "resume-recovery";
  const report = buildReport({
    reportId: "rpt_w91_resume",
    projectId: recoveryProjectId,
    workloadId,
    reportedAt: new Date("2026-10-21T15:00:00Z"),
  });

  await reportRuntimeStatus(report, { logger: silentLogger });

  await assert.rejects(
    () =>
      withRetry(
        () => reportRuntimeStatus(report, { logger: silentLogger }),
        {
          maxAttempts: 3,
          sleep: async () => {},
          logger: silentLogger,
          operationName: "resume-report",
        }
      ),
    ActualStateConflictError
  );

  const rows = await listObservations(recoveryProjectId, workloadId);
  assert.equal(rows.length, 1);
  const stored = await getLatestObservation(recoveryProjectId, workloadId);
  assert.equal(stored?.observationId, "rpt_w91_resume");
});

test("recovery: an application still unreachable after recovery stays accurately unhealthy", async () => {
  const workloadId = "still-unreachable";
  await stopServer();
  serverPort = await startServer();
  await stopServer();

  const check = await runHealthCheck(
    httpProbe,
    {
      projectId: recoveryProjectId,
      workloadId,
      target: {
        scheme: "http",
        host: "127.0.0.1",
        port: serverPort,
        path: "/health",
      },
    },
    { logger: silentLogger, generateCheckId: () => "chk_w91_unreachable" }
  );
  assert.equal(check.status, "unhealthy");

  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w91_still_unhealthy",
      projectId: recoveryProjectId,
      workloadId,
      reportedAt: new Date("2026-10-21T16:00:00Z"),
      status: "unknown",
      health: { status: "unhealthy" },
      diagnostics: {
        message: check.failure?.message ?? "unreachable",
        reason: check.failure?.kind ?? "unknown",
        details: { checkId: check.checkId },
      },
    }),
    { logger: silentLogger }
  );

  const view = await getRuntimeStatus(recoveryProjectId, workloadId, {
    now: new Date("2026-10-21T16:00:10Z"),
  });
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.snapshot.health.status, "unhealthy");
  assert.equal(view.snapshot.status, "unknown");
  assert.equal(
    view.snapshot.diagnostics?.details?.checkId,
    "chk_w91_unreachable"
  );

  serverPort = await startServer();
});
