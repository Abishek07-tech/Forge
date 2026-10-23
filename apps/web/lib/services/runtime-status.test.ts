import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { RuntimeStatusReport } from "../../types/runtime-status.ts";
import { prisma } from "../prisma.ts";
import {
  deleteObservationsForProject,
  InvalidProjectError,
} from "../persistence/actual-state.ts";
import {
  createLogger,
  createTestLogger,
  silentSink,
} from "../observability/logger.ts";
import {
  ActualStateConflictError,
  ActualStateValidationFailedError,
  getLatestObservation,
  listObservations,
} from "./actual-state.ts";
import {
  detectStatusTransition,
  getRuntimeStatus,
  reportRuntimeStatus,
  RuntimeStatusServiceError,
} from "./runtime-status.ts";
import { classifyFailure } from "../resilience/classify.ts";
import { withRetry } from "../resilience/retry.ts";
import { ActualStateServiceError } from "./actual-state.ts";

const KEEP = process.env.W88_KEEP === "1";
const mainProjectName = "w88-runtime-status";
const otherProjectName = "w88-runtime-status-other";

const silentLogger = createLogger({ sink: silentSink, level: "silent" });

function buildReport(
  overrides: Partial<RuntimeStatusReport> = {}
): RuntimeStatusReport {
  return {
    reportId: "rpt_w88_001",
    projectId: "prj_w88_placeholder",
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
    diagnostics: {
      message: "probe succeeded",
      reason: "http-200",
      details: { endpoint: "/health" },
    },
    ...overrides,
  };
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

let mainProjectId: string;
let otherProjectId: string;

before(async () => {
  mainProjectId = await ensureProject(mainProjectName);
  otherProjectId = await ensureProject(otherProjectName);
  if (!KEEP) {
    await deleteObservationsForProject(mainProjectId);
    await deleteObservationsForProject(otherProjectId);
  }
});

after(async () => {
  try {
    if (!KEEP && mainProjectId) {
      await deleteObservationsForProject(mainProjectId);
      await prisma.project.deleteMany({ where: { name: mainProjectName } });
    }
    if (!KEEP && otherProjectId) {
      await deleteObservationsForProject(otherProjectId);
      await prisma.project.deleteMany({ where: { name: otherProjectName } });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("a valid runtime status report is persisted and retrievable", async () => {
  const report = buildReport({
    reportId: "rpt_w88_valid",
    projectId: mainProjectId,
  });
  const view = await reportRuntimeStatus(report, { logger: silentLogger });
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;

  assert.equal(view.projectId, mainProjectId);
  assert.equal(view.workloadId, "default");
  assert.equal(view.snapshot.status, "running");
  assert.equal(view.snapshot.health.status, "healthy");
  assert.equal(view.snapshot.application.image, "forge-api:v1");
  assert.equal(view.observation.observationId, "rpt_w88_valid");
  assert.equal(view.observation.source, "node-agent");
  assert.equal(
    view.observation.observedAt.toISOString(),
    "2026-10-21T10:00:00.000Z"
  );

  const stored = await getLatestObservation(mainProjectId, "default");
  assert.ok(stored);
  assert.equal(stored?.observationId, "rpt_w88_valid");
  assert.equal(stored?.diagnostics?.message, "probe succeeded");
  assert.equal(stored?.diagnostics?.reason, "http-200");
  assert.equal(stored?.diagnostics?.details?.endpoint, "/health");
});

test("an invalid or incomplete report is rejected before persistence", async () => {
  const before = await listObservations(mainProjectId, "default");
  await assert.rejects(
    () =>
      reportRuntimeStatus(
        buildReport({
          reportId: "rpt_w88_invalid",
          projectId: mainProjectId,
          status: "exploded" as RuntimeStatusReport["status"],
        }),
        { logger: silentLogger }
      ),
    ActualStateValidationFailedError
  );
  const after = await listObservations(mainProjectId, "default");
  assert.equal(after.length, before.length);
});

test("an incomplete report missing required fields is rejected", async () => {
  await assert.rejects(
    () =>
      reportRuntimeStatus(
        {
          ...buildReport({ projectId: mainProjectId }),
          health: undefined as unknown as RuntimeStatusReport["health"],
        },
        { logger: silentLogger }
      ),
    ActualStateValidationFailedError
  );
});

test("a report for an unknown project is rejected with InvalidProjectError", async () => {
  await assert.rejects(
    () =>
      reportRuntimeStatus(
        buildReport({
          reportId: "rpt_w88_unknown_project",
          projectId: "prj_does_not_exist_w88",
        }),
        { logger: silentLogger }
      ),
    InvalidProjectError
  );
});

test("a repeated report with the same reportId conflicts and does not duplicate", async () => {
  const report = buildReport({
    reportId: "rpt_w88_repeat",
    projectId: mainProjectId,
  });
  await reportRuntimeStatus(report, { logger: silentLogger });
  await assert.rejects(
    () => reportRuntimeStatus(report, { logger: silentLogger }),
    ActualStateConflictError
  );
  const rows = await listObservations(mainProjectId, "default");
  const matches = rows.filter((row) => row.observationId === "rpt_w88_repeat");
  assert.equal(matches.length, 1);
});

test("a stale (out-of-order) report is accepted but never displaces newer status", async () => {
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_newer",
      projectId: mainProjectId,
      workloadId: "stale-demo",
      reportedAt: new Date("2026-10-21T12:00:00Z"),
      status: "running",
      health: { status: "healthy" },
    }),
    { logger: silentLogger }
  );
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_older",
      projectId: mainProjectId,
      workloadId: "stale-demo",
      reportedAt: new Date("2026-10-21T09:00:00Z"),
      status: "failed",
      health: { status: "unhealthy" },
      diagnostics: { message: "late report from a slow agent" },
    }),
    { logger: silentLogger }
  );

  const view = await getRuntimeStatus(mainProjectId, "stale-demo");
  assert.equal(view.availability, "known");
  if (view.availability !== "known") return;
  assert.equal(view.observation.observationId, "rpt_w88_newer");
  assert.equal(view.snapshot.status, "running");

  const history = await listObservations(mainProjectId, "stale-demo");
  assert.equal(history.length, 2);
});

test("runtime status is isolated per project", async () => {
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_iso_main",
      projectId: mainProjectId,
      workloadId: "isolated",
      status: "running",
    }),
    { logger: silentLogger }
  );
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_iso_other",
      projectId: otherProjectId,
      workloadId: "isolated",
      status: "failed",
      health: { status: "unknown" },
    }),
    { logger: silentLogger }
  );

  const mainView = await getRuntimeStatus(mainProjectId, "isolated");
  const otherView = await getRuntimeStatus(otherProjectId, "isolated");
  assert.equal(mainView.availability, "known");
  assert.equal(otherView.availability, "known");
  if (mainView.availability !== "known") return;
  if (otherView.availability !== "known") return;
  assert.equal(mainView.snapshot.status, "running");
  assert.equal(otherView.snapshot.status, "failed");
  assert.equal(mainView.observation.observationId, "rpt_w88_iso_main");
  assert.equal(otherView.observation.observationId, "rpt_w88_iso_other");
});

test("a workload with no observations reports unknown availability", async () => {
  const view = await getRuntimeStatus(mainProjectId, "never-reported");
  assert.equal(view.availability, "unknown");
  if (view.availability !== "unknown") return;
  assert.equal(view.reason, "no-observations");
});

test("staleness is computed against the supplied clock", async () => {
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_stale",
      projectId: mainProjectId,
      workloadId: "stale-check",
      reportedAt: new Date("2026-10-21T10:00:00Z"),
    }),
    { logger: silentLogger }
  );
  const fresh = await getRuntimeStatus(mainProjectId, "stale-check", {
    now: new Date("2026-10-21T10:02:00Z"),
    staleAfterMs: 5 * 60 * 1000,
  });
  assert.equal(fresh.availability, "known");
  if (fresh.availability !== "known") return;
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMs, 120_000);

  const stale = await getRuntimeStatus(mainProjectId, "stale-check", {
    now: new Date("2026-10-21T10:10:00Z"),
    staleAfterMs: 5 * 60 * 1000,
  });
  assert.equal(stale.availability, "known");
  if (stale.availability !== "known") return;
  assert.equal(stale.stale, true);
  assert.equal(stale.ageMs, 600_000);
});

test("invalid identifiers are rejected by the service boundary", async () => {
  await assert.rejects(
    () => getRuntimeStatus("", "default"),
    RuntimeStatusServiceError
  );
  await assert.rejects(
    () => getRuntimeStatus(mainProjectId, ""),
    RuntimeStatusServiceError
  );
});

test("diagnostics round-trip through persistence", async () => {
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_diag",
      projectId: mainProjectId,
      workloadId: "diag-demo",
      diagnostics: {
        message: "restart backoff active",
        reason: "probe-timeout",
        details: { attempts: "3", lastError: "timeout" },
      },
    }),
    { logger: silentLogger }
  );
  const stored = await getLatestObservation(mainProjectId, "diag-demo");
  assert.equal(stored?.diagnostics?.message, "restart backoff active");
  assert.equal(stored?.diagnostics?.details?.attempts, "3");
});

test("status transitions are traced through the structured logs", async () => {
  const workloadId = "transition-demo";
  const { logger, records } = createTestLogger();

  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_trans_1",
      projectId: mainProjectId,
      workloadId,
      reportedAt: new Date("2026-10-21T11:00:00Z"),
      status: "running",
      health: { status: "healthy" },
    }),
    { logger }
  );
  await reportRuntimeStatus(
    buildReport({
      reportId: "rpt_w88_trans_2",
      projectId: mainProjectId,
      workloadId,
      reportedAt: new Date("2026-10-21T11:05:00Z"),
      status: "failed",
      health: { status: "unhealthy" },
      diagnostics: { message: "container exited" },
    }),
    { logger }
  );

  const transitions = records.filter(
    (record) => record.event === "runtime-status.transition"
  );
  assert.equal(transitions.length, 1);
  const transition = transitions[0];
  assert.equal(transition.context.previousStatus, "running");
  assert.equal(transition.context.previousHealth, "healthy");
  assert.equal(transition.context.newStatus, "failed");
  assert.equal(transition.context.newHealth, "unhealthy");
  assert.equal(transition.context.projectId, mainProjectId);
  assert.equal(transition.context.workloadId, workloadId);
  assert.equal(transition.context.component, "runtime-status");

  const recorded = records.filter(
    (record) => record.event === "runtime-status.report.recorded"
  );
  assert.equal(recorded.length, 2);
});

test("rejected and conflicting reports produce diagnostic log records", async () => {
  const { logger, records } = createTestLogger();

  await assert.rejects(
    () =>
      reportRuntimeStatus(
        buildReport({
          reportId: "rpt_w88_log_invalid",
          projectId: mainProjectId,
          status: "nope" as RuntimeStatusReport["status"],
        }),
        { logger }
      ),
    ActualStateValidationFailedError
  );

  const rejected = records.find(
    (record) => record.event === "runtime-status.report.rejected"
  );
  assert.ok(rejected);
  assert.ok(rejected?.context.errorPaths !== undefined);
  assert.equal(rejected?.context.component, "runtime-status");

  const duplicate = buildReport({
    reportId: "rpt_w88_log_dup",
    projectId: mainProjectId,
    workloadId: "conflict-log-demo",
  });
  await reportRuntimeStatus(duplicate, { logger });
  await assert.rejects(
    () => reportRuntimeStatus(duplicate, { logger }),
    ActualStateConflictError
  );
  const conflict = records.find(
    (record) => record.event === "runtime-status.report.conflict"
  );
  assert.ok(conflict);
  assert.equal(conflict?.level, "warn");
});

test("detectStatusTransition only fires on real changes", () => {
  assert.equal(
    detectStatusTransition(null, { status: "running", health: "healthy" }),
    null
  );
  assert.equal(
    detectStatusTransition(
      { status: "running", health: "healthy" },
      { status: "running", health: "healthy" }
    ),
    null
  );
  const transition = detectStatusTransition(
    { status: "running", health: "unknown" },
    { status: "running", health: "healthy" }
  );
  assert.ok(transition);
  assert.equal(transition?.from.health, "unknown");
  assert.equal(transition?.to.health, "healthy");
});

test("real service errors classify correctly for retry decisions", async () => {
  const duplicate = buildReport({
    reportId: "rpt_w88_classify_dup",
    projectId: mainProjectId,
    workloadId: "classify-demo",
  });
  await reportRuntimeStatus(duplicate, { logger: silentLogger });

  await assert.rejects(
    () => reportRuntimeStatus(duplicate, { logger: silentLogger }),
    (error: unknown) => {
      assert.equal(classifyFailure(error).disposition, "permanent");
      return true;
    }
  );

  await assert.rejects(
    () =>
      reportRuntimeStatus(
        buildReport({
          reportId: "rpt_w88_classify_invalid",
          projectId: mainProjectId,
          status: "bogus" as RuntimeStatusReport["status"],
        }),
        { logger: silentLogger }
      ),
    (error: unknown) => {
      assert.equal(classifyFailure(error).disposition, "invalid");
      return true;
    }
  );

  await assert.rejects(
    () =>
      reportRuntimeStatus(
        buildReport({
          reportId: "rpt_w88_classify_orphan",
          projectId: "prj_w88_missing_forever",
        }),
        { logger: silentLogger }
      ),
    (error: unknown) => {
      assert.equal(classifyFailure(error).disposition, "permanent");
      return true;
    }
  );

  const persistenceError = new ActualStateServiceError(
    "PERSISTENCE_FAILED",
    "Failed to persist the Actual State observation."
  );
  assert.equal(classifyFailure(persistenceError).disposition, "retryable");
  assert.equal(
    classifyFailure(new RuntimeStatusServiceError([{ path: "x", message: "x" }]))
      .disposition,
    "invalid"
  );
});

test("withRetry around a duplicate report stops at the conflict without duplicate rows", async () => {
  const workloadId = "retry-conflict-demo";
  const report = buildReport({
    reportId: "rpt_w88_retry_dup",
    projectId: mainProjectId,
    workloadId,
  });

  await withRetry(() => reportRuntimeStatus(report, { logger: silentLogger }), {
    sleep: async () => {},
    logger: silentLogger,
    operationName: "report-runtime-status",
  });

  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts += 1;
          return reportRuntimeStatus(report, { logger: silentLogger });
        },
        {
          maxAttempts: 5,
          sleep: async () => {},
          logger: silentLogger,
          operationName: "report-runtime-status",
        }
      ),
    ActualStateConflictError
  );
  assert.equal(attempts, 1);

  const rows = await listObservations(mainProjectId, workloadId);
  assert.equal(rows.length, 1);
});
