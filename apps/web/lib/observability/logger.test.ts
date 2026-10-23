import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createInMemorySink,
  createLogger,
  createTestLogger,
  newCorrelationId,
  REDACTED,
  redactSecrets,
  type LogRecord,
} from "./logger.ts";

test("important events are logged with structured context", () => {
  const { logger, records } = createTestLogger();
  logger.info("runtime-status.report.recorded", {
    projectId: "prj_1",
    workloadId: "default",
    reportId: "rpt_1",
    status: "running",
  });
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.event, "runtime-status.report.recorded");
  assert.equal(record.level, "info");
  assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
  assert.equal(record.context.projectId, "prj_1");
  assert.equal(record.context.workloadId, "default");
  assert.equal(record.context.reportId, "rpt_1");
  assert.equal(record.context.status, "running");
});

test("child loggers merge context into every record", () => {
  const { logger, records } = createTestLogger();
  const child = logger.child({
    component: "health-check",
    projectId: "prj_2",
    checkId: "chk_1",
  });
  child.warn("health-check.completed", { status: "unhealthy", durationMs: 12 });
  assert.equal(records.length, 1);
  assert.equal(records[0].context.component, "health-check");
  assert.equal(records[0].context.projectId, "prj_2");
  assert.equal(records[0].context.checkId, "chk_1");
  assert.equal(records[0].context.status, "unhealthy");
  assert.equal(records[0].context.durationMs, 12);
});

test("failures carry useful diagnostic information", () => {
  const { logger, records } = createTestLogger();
  logger.error("runtime-status.report.failed", {
    errorName: "ActualStateServiceError",
    errorMessage: "Failed to persist the Actual State observation.",
    projectId: "prj_3",
  });
  const record = records[0];
  assert.equal(record.level, "error");
  assert.equal(record.context.errorName, "ActualStateServiceError");
  assert.match(
    String(record.context.errorMessage),
    /Failed to persist the Actual State/
  );
});

test("secret-looking keys are redacted at the top level", () => {
  const redacted = redactSecrets({
    password: "hunter2",
    apiKey: "abc123",
    authorization: "Bearer xyz",
    token: "jwt-like",
    projectId: "prj_ok",
  });
  assert.deepEqual(redacted, {
    password: REDACTED,
    apiKey: REDACTED,
    authorization: REDACTED,
    token: REDACTED,
    projectId: "prj_ok",
  });
});

test("secrets are not exposed in nested logs, arrays, or details payloads", () => {
  const { logger, records } = createTestLogger();
  logger.info("runtime-status.report.recorded", {
    projectId: "prj_4",
    credentials: { password: "hunter2", user: "admin" },
    diagnostics: {
      details: { dbPassword: "letmein", endpoint: "db:5432" },
    },
    headers: [{ authorization: "Bearer abc" }],
    sourceUser: "admin",
  });
  const line = JSON.stringify(records[0]);
  assert.ok(!line.includes("hunter2"));
  assert.ok(!line.includes("letmein"));
  assert.ok(!line.includes("Bearer abc"));
  assert.ok(line.includes("db:5432"));
  assert.ok(line.includes("admin"));
  assert.ok(records[0].context.credentials === REDACTED);
});

test("log levels below the configured threshold are dropped", () => {
  const sink = createInMemorySink();
  const logger = createLogger({ sink, level: "warn" });
  logger.debug("debug.event");
  logger.info("info.event");
  logger.warn("warn.event");
  logger.error("error.event");
  assert.deepEqual(
    sink.records.map((record) => record.event),
    ["warn.event", "error.event"]
  );
});

test("a throwing sink never propagates to the caller", () => {
  const logger = createLogger({
    sink: {
      write(): void {
        throw new Error("sink exploded");
      },
    },
    level: "info",
  });
  assert.doesNotThrow(() => logger.info("observability.test-event"));
  assert.doesNotThrow(() => logger.error("observability.test-event"));
});

test("correlation ids can be attached for cross-operation tracing", () => {
  const correlationId = newCorrelationId();
  const { logger, records } = createTestLogger();
  const traced = logger.child({ correlationId });
  traced.info("health-check.started");
  assert.equal(records[0].context.correlationId, correlationId);
});

test("the console sink emits valid JSON lines", () => {
  const sink = createInMemorySink();
  const logger = createLogger({
    sink,
    clock: () => new Date("2026-10-21T12:00:00Z"),
  });
  logger.info("observability.json-line", { a: 1 });
  const record: LogRecord = sink.records[0];
  const parsed = JSON.parse(
    JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      event: record.event,
      ...record.context,
    })
  );
  assert.equal(parsed.event, "observability.json-line");
  assert.equal(parsed.timestamp, "2026-10-21T12:00:00.000Z");
  assert.equal(parsed.a, 1);
});
