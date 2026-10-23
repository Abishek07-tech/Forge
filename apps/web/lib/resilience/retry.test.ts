import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyFailure } from "./classify.ts";
import {
  computeBackoffDelay,
  RetryExhaustedError,
  withRetry,
} from "./retry.ts";
import { createTestLogger, silentSink, createLogger } from "../observability/logger.ts";

const silentLogger = createLogger({ sink: silentSink, level: "silent" });

function transientError(message = "connection reset"): Error {
  const error = new Error(message);
  error.name = "Error";
  (error as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
  return error;
}

function conflictError(message = "duplicate report"): Error {
  const error = new Error(message);
  error.name = "ActualStateConflictError";
  (error as Error & { code?: string }).code = "CONFLICT";
  return error;
}

function validationError(message = "invalid report"): Error {
  const error = new Error(message);
  error.name = "ActualStateValidationFailedError";
  (error as Error & { code?: string }).code = "VALIDATION_FAILED";
  return error;
}

async function fakeSleep(): Promise<void> {
  /* no real waiting in unit tests */
}

test("classification: transient network failures are retryable", () => {
  assert.equal(classifyFailure(transientError()).disposition, "retryable");
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(classifyFailure(timeout).disposition, "retryable");
  const persistence = new Error("db down");
  (persistence as Error & { code?: string }).code = "PERSISTENCE_FAILED";
  assert.equal(classifyFailure(persistence).disposition, "retryable");
});

test("classification: permanent failures are not retryable", () => {
  assert.equal(classifyFailure(conflictError()).disposition, "permanent");
  const invalidProject = new Error("unknown project");
  invalidProject.name = "InvalidProjectError";
  assert.equal(classifyFailure(invalidProject).disposition, "permanent");
});

test("classification: invalid requests are not retryable", () => {
  assert.equal(classifyFailure(validationError()).disposition, "invalid");
  const healthValidation = new Error("bad context");
  healthValidation.name = "HealthCheckValidationError";
  assert.equal(classifyFailure(healthValidation).disposition, "invalid");
});

test("transient failure: recovery after a transient error succeeds", async () => {
  let attempts = 0;
  const result = await withRetry(
    async (attempt) => {
      attempts = attempt;
      if (attempt < 3) {
        throw transientError();
      }
      return "recovered";
    },
    { sleep: fakeSleep, logger: silentLogger, operationName: "transient-demo" }
  );
  assert.equal(result, "recovered");
  assert.equal(attempts, 3);
});

test("permanent failure: a conflict thrown by the operation is not retried", async () => {
  let calls = 0;
  const error = conflictError();
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw error;
        },
        { sleep: fakeSleep, logger: silentLogger }
      ),
    (thrown: unknown) => thrown === error
  );
  assert.equal(calls, 1);
});

test("invalid request: validation failures are thrown immediately", async () => {
  let calls = 0;
  const error = validationError();
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw error;
        },
        { sleep: fakeSleep, logger: silentLogger }
      ),
    (thrown: unknown) => thrown === error
  );
  assert.equal(calls, 1);
});

test("repeated failure: retries are bounded and the last error is preserved", async () => {
  const lastError = transientError("always failing");
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw lastError;
        },
        {
          maxAttempts: 4,
          sleep: fakeSleep,
          logger: silentLogger,
          operationName: "bounded-demo",
        }
      ),
    (error: unknown) => {
      assert.ok(error instanceof RetryExhaustedError);
      const exhausted = error as RetryExhaustedError;
      assert.equal(exhausted.attempts, 4);
      assert.equal(exhausted.lastError, lastError);
      assert.equal(exhausted.lastDisposition, "retryable");
      assert.equal(exhausted.timedOut, false);
      assert.match(exhausted.message, /bounded-demo/);
      assert.match(exhausted.message, /always failing/);
      return true;
    }
  );
  assert.equal(calls, 4);
});

test("retry limit: exactly maxAttempts operations run, never more", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw transientError();
        },
        { maxAttempts: 5, sleep: fakeSleep, logger: silentLogger }
      ),
    RetryExhaustedError
  );
  assert.equal(calls, 5);
});

test("backoff: delays grow exponentially and are capped, preventing tight loops", () => {
  assert.equal(computeBackoffDelay(1, 10, 100), 10);
  assert.equal(computeBackoffDelay(2, 10, 100), 20);
  assert.equal(computeBackoffDelay(3, 10, 100), 40);
  assert.equal(computeBackoffDelay(4, 10, 100), 80);
  assert.equal(computeBackoffDelay(5, 10, 100), 100);
  assert.equal(computeBackoffDelay(6, 10, 100), 100);
});

test("backoff: scheduled delays are actually awaited between attempts", async () => {
  const observed: number[] = [];
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          throw transientError();
        },
        {
          maxAttempts: 4,
          baseDelayMs: 5,
          maxDelayMs: 50,
          sleep: async (ms) => {
            observed.push(ms);
          },
          logger: silentLogger,
        }
      ),
    RetryExhaustedError
  );
  assert.deepEqual(observed, [5, 10, 20]);
  for (const delay of observed) {
    assert.ok(delay > 0);
  }
});

test("deadline: retries stop once the total time budget would be exceeded", async () => {
  let calls = 0;
  let fakeClock = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw transientError();
        },
        {
          maxAttempts: 10,
          baseDelayMs: 50,
          maxDelayMs: 50,
          deadlineMs: 60,
          sleep: async (ms) => {
            fakeClock += ms;
          },
          now: () => fakeClock,
          logger: silentLogger,
        }
      ),
    (error: unknown) => {
      assert.ok(error instanceof RetryExhaustedError);
      assert.equal((error as RetryExhaustedError).timedOut, true);
      return true;
    }
  );
  assert.ok(calls < 10);
  assert.equal(calls, 2);
});

test("duplicate operation: an idempotent store never sees duplicate side effects", async () => {
  const store = new Set<string>();
  async function idempotentInsert(key: string): Promise<"created" | "exists"> {
    if (store.has(key)) {
      const error = conflictError(`duplicate ${key}`);
      throw error;
    }
    store.add(key);
    return "created";
  }

  const first = await withRetry(() => idempotentInsert("rpt_1"), {
    sleep: fakeSleep,
    logger: silentLogger,
  });
  assert.equal(first, "created");
  assert.equal(store.size, 1);

  await assert.rejects(
    () => idempotentInsert("rpt_1"),
    (error: unknown) => error instanceof Error && error.name === "ActualStateConflictError"
  );
  assert.equal(store.size, 1);
});

test("duplicate operation: retrying after a partial failure does not re-run side effects", async () => {
  const store = new Set<string>();
  let sideEffects = 0;
  await assert.rejects(
    () =>
      withRetry(
        async (attempt) => {
          if (attempt === 1) {
            store.add("key-1");
            sideEffects += 1;
            throw transientError("response lost after insert");
          }
          if (store.has("key-1")) {
            throw conflictError("already inserted");
          }
          store.add("key-1");
          sideEffects += 1;
          return "created";
        },
        { sleep: fakeSleep, logger: silentLogger }
      ),
    (error: unknown) => error instanceof Error && error.name === "ActualStateConflictError"
  );
  assert.equal(sideEffects, 1);
  assert.equal(store.size, 1);
});

test("recovery: normal operation resumes after transient errors without duplicates", async () => {
  const created: string[] = [];
  const result = await withRetry(
    async (attempt) => {
      if (attempt <= 2) {
        throw transientError("db briefly unavailable");
      }
      created.push("obs_1");
      return { observationId: "obs_1" };
    },
    { sleep: fakeSleep, logger: silentLogger }
  );
  assert.deepEqual(result, { observationId: "obs_1" });
  assert.deepEqual(created, ["obs_1"]);
});

test("retry events are observable with diagnostic context", async () => {
  const { logger, records } = createTestLogger();
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          throw transientError("still down");
        },
        { maxAttempts: 3, baseDelayMs: 1, sleep: fakeSleep, logger }
      ),
    RetryExhaustedError
  );
  const scheduled = records.filter(
    (record) => record.event === "resilience.retry.scheduled"
  );
  const exhausted = records.find(
    (record) => record.event === "resilience.retry.exhausted"
  );
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[0].context.attempt, 1);
  assert.equal(scheduled[0].context.disposition, "retryable");
  assert.ok(exhausted);
  assert.equal(exhausted?.context.attempts, 3);
});

test("non-Error throwables are classified and handled safely", async () => {
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          throw "plain string failure";
        },
        { maxAttempts: 2, sleep: fakeSleep, logger: silentLogger }
      ),
    (error: unknown) => {
      assert.ok(error instanceof RetryExhaustedError);
      assert.equal((error as RetryExhaustedError).lastError, "plain string failure");
      return true;
    }
  );
});
