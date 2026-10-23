import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";import { after, before, test } from "node:test";
import type {
  HealthCheckResult,
  HealthProbeOutcome,
  HealthProbeTarget,
} from "../../types/health-check.ts";
import {
  evaluateHealthOutcome,
  HealthCheckValidationError,
  runHealthCheck,
} from "./evaluate.ts";
import {
  buildProbeUrl,
  createHttpHealthProbe,
  createStaticHealthProbe,
  neverResolvingHealthProbe,
} from "./probe.ts";
import { createLogger, createTestLogger, silentSink } from "../observability/logger.ts";

const silentLogger = createLogger({ sink: silentSink, level: "silent" });

function context(
  overrides: Partial<{ projectId: string; workloadId: string; target: HealthProbeTarget }> = {}
) {
  return {
    projectId: "prj_w87_health",
    workloadId: "default",
    target: {
      scheme: "http" as const,
      host: "127.0.0.1",
      port: 1,
      path: "/health",
    },
    ...overrides,
  };
}

const healthyOutcome: HealthProbeOutcome = {
  reachable: true,
  statusCode: 200,
  latencyMs: 5,
  errorKind: null,
  errorMessage: null,
};

let server: Server;
let healthyPort: number;
let unhealthyPort: number;
let slowPort: number;
const httpProbe = createHttpHealthProbe();

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/unhealthy") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "unavailable" }));
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 2_000);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  healthyPort = address.port;
  unhealthyPort = address.port;
  slowPort = address.port;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

test("buildProbeUrl renders scheme, authority, and path", () => {
  assert.equal(
    buildProbeUrl({
      scheme: "https",
      host: "example.internal",
      port: 8443,
      path: "healthz",
    }),
    "https://example.internal:8443/healthz"
  );
  assert.equal(
    buildProbeUrl({
      scheme: "http",
      host: "127.0.0.1",
      port: 80,
      path: "/health",
    }),
    "http://127.0.0.1/health"
  );
});

test("healthy application: 2xx probe produces a healthy result", async () => {
  const result = await runHealthCheck(
    httpProbe,
    context({
      target: {
        scheme: "http",
        host: "127.0.0.1",
        port: healthyPort,
        path: "/health",
      },
    }),
    { logger: silentLogger }
  );
  assert.equal(result.status, "healthy");
  assert.equal(result.failure, null);
  assert.equal(result.outcome?.statusCode, 200);
  assert.equal(result.outcome?.reachable, true);
  assert.equal(result.projectId, "prj_w87_health");
  assert.equal(result.workloadId, "default");
});

test("unhealthy application: 5xx probe produces an unhealthy result with diagnostics", async () => {
  const result = await runHealthCheck(
    httpProbe,
    context({
      target: {
        scheme: "http",
        host: "127.0.0.1",
        port: unhealthyPort,
        path: "/unhealthy",
      },
    }),
    { logger: silentLogger }
  );
  assert.equal(result.status, "unhealthy");
  assert.equal(result.outcome?.statusCode, 503);
  assert.ok(result.failure);
  assert.equal(result.failure?.kind, "http-error");
  assert.equal(result.failure?.statusCode, 503);
  assert.match(result.failure?.message ?? "", /503/);
});

test("failed health-check request: connection refused is unhealthy, not healthy", async () => {
  const result = await runHealthCheck(
    httpProbe,
    context({
      target: {
        scheme: "http",
        host: "127.0.0.1",
        port: 1,
        path: "/health",
      },
    }),
    { logger: silentLogger }
  );
  assert.equal(result.status, "unhealthy");
  assert.notEqual(result.status, "healthy");
  assert.equal(result.outcome?.reachable, false);
  assert.ok(result.failure);
  assert.ok(
    ["connection-refused", "network-error", "timeout"].includes(
      result.failure?.kind ?? ""
    )
  );
});

test("timeout: a probe that never resolves is bounded by the configured timeout", async () => {
  const result = await runHealthCheck(
    neverResolvingHealthProbe,
    context(),
    { config: { timeoutMs: 40 }, logger: silentLogger }
  );
  assert.equal(result.status, "unhealthy");
  assert.equal(result.outcome?.errorKind, "timeout");
  assert.equal(result.failure?.kind, "timeout");
  assert.match(result.failure?.message ?? "", /40ms/);
});

test("timeout: a slow real HTTP endpoint is bounded by the configured timeout", async () => {
  const result = await runHealthCheck(
    httpProbe,
    context({
      target: {
        scheme: "http",
        host: "127.0.0.1",
        port: slowPort,
        path: "/slow",
      },
    }),
    { config: { timeoutMs: 80 }, logger: silentLogger }
  );
  assert.equal(result.status, "unhealthy");
  assert.equal(result.failure?.kind, "timeout");
});

test("probe errors are surfaced as unhealthy with a probe-error failure", async () => {
  const result = await runHealthCheck(
    createStaticHealthProbe({ error: new Error("probe exploded") }),
    context(),
    { logger: silentLogger }
  );
  assert.equal(result.status, "unhealthy");
  assert.equal(result.failure?.kind, "probe-error");
  assert.match(result.failure?.message ?? "", /probe exploded/);
});

test("missing or unknown health information: an incomplete outcome is unknown, never healthy", () => {
  const incomplete: HealthProbeOutcome = {
    reachable: false,
    statusCode: null,
    latencyMs: null,
    errorKind: null,
    errorMessage: null,
  };
  const classified = evaluateHealthOutcome(incomplete);
  assert.equal(classified.status, "unknown");
  assert.equal(classified.failure?.kind, "incomplete-outcome");
});

test("a probe reporting reachable without a status code is unknown, not healthy", () => {
  const classified = evaluateHealthOutcome({
    reachable: true,
    statusCode: null,
    latencyMs: 1,
    errorKind: null,
    errorMessage: null,
  });
  assert.equal(classified.status, "unknown");
});

test("process-exists-but-unreachable is never healthy (no liveness inference)", async () => {
  const existsButUnreachable = createStaticHealthProbe({
    outcome: {
      reachable: false,
      statusCode: null,
      latencyMs: 2,
      errorKind: "connection-refused",
      errorMessage: "Health probe could not reach the target.",
    },
  });
  const result = await runHealthCheck(existsButUnreachable, context(), {
    logger: silentLogger,
  });
  assert.equal(result.status, "unhealthy");
  assert.notEqual(result.status, "healthy");
});

test("timestamps and duration are set correctly and never negative", async () => {
  let tick = 0;
  const fixedNow = () => {
    tick += 1;
    return new Date(Date.UTC(2026, 9, 21, 12, 0, tick));
  };
  const result = await runHealthCheck(
    createStaticHealthProbe({ outcome: healthyOutcome }),
    context(),
    { now: fixedNow, generateCheckId: () => "chk_fixed_001", logger: silentLogger }
  );
  assert.equal(result.checkId, "chk_fixed_001");
  assert.equal(result.startedAt.toISOString(), "2026-10-21T12:00:01.000Z");
  assert.equal(result.checkedAt.toISOString(), "2026-10-21T12:00:02.000Z");
  assert.equal(result.durationMs, 1000);
  assert.ok(result.durationMs >= 0);
});

test("completed results never report the in-flight checking status", async () => {
  const result: HealthCheckResult = await runHealthCheck(
    createStaticHealthProbe({ outcome: healthyOutcome }),
    context(),
    { logger: silentLogger }
  );
  assert.ok(["healthy", "unhealthy", "unknown"].includes(result.status));
  assert.notEqual(result.status, "checking");
});

test("invalid check context is rejected before any probe runs", async () => {
  await assert.rejects(
    () =>
      runHealthCheck(
        createStaticHealthProbe({ outcome: healthyOutcome }),
        context({ projectId: " " })
      ),
    HealthCheckValidationError
  );
  await assert.rejects(
    () =>
      runHealthCheck(
        createStaticHealthProbe({ outcome: healthyOutcome }),
        context({
          target: {
            scheme: "ftp" as unknown as "http",
            host: "127.0.0.1",
            port: 80,
            path: "/health",
          },
        })
      ),
    HealthCheckValidationError
  );
});

test("the same probe outcome classifies deterministically", () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(evaluateHealthOutcome(healthyOutcome).status, "healthy");
    assert.equal(
      evaluateHealthOutcome({
        reachable: false,
        statusCode: 500,
        latencyMs: 1,
        errorKind: "http-error",
        errorMessage: "Health endpoint responded with status 500.",
      }).status,
      "unhealthy"
    );
  }
});

test("health-check outcomes are traced in structured logs without exposing secrets", async () => {
  const { logger, records } = createTestLogger();
  await runHealthCheck(
    httpProbe,
    context({
      target: {
        scheme: "http",
        host: "127.0.0.1",
        port: unhealthyPort,
        path: "/unhealthy",
      },
    }),
    { logger }
  );

  const started = records.find(
    (record) => record.event === "health-check.started"
  );
  const completed = records.find(
    (record) => record.event === "health-check.completed"
  );
  assert.ok(started);
  assert.ok(completed);
  assert.equal(started?.context.component, "health-check");
  assert.equal(started?.context.projectId, "prj_w87_health");
  assert.equal(completed?.level, "warn");
  assert.equal(completed?.context.status, "unhealthy");
  assert.equal(completed?.context.httpStatus, 503);
  assert.equal(completed?.context.failureKind, "http-error");
  assert.ok(typeof completed?.context.durationMs === "number");
  assert.ok(completed?.context.checkId);

  const line = JSON.stringify(records);
  assert.ok(!line.includes("authorization"));
  assert.ok(!line.includes("password"));
});
