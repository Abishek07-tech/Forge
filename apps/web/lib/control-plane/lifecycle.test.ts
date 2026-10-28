import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ACTIVE_JOB_STATUSES,
  EXECUTION_JOB_STATUSES,
  isActiveJobStatus,
  isTerminalJobStatus,
  TERMINAL_JOB_STATUSES,
} from "../../types/control-plane.ts";
import {
  allowedTransitionsFrom,
  assertValidJobTransition,
  canTransitionJobStatus,
  InvalidJobTransitionError,
  isExecutionJobStatus,
  lifecycleTimestampsForTransition,
} from "./lifecycle.ts";

test("LIFECYCLE: known statuses are recognized", () => {
  for (const status of EXECUTION_JOB_STATUSES) {
    assert.equal(isExecutionJobStatus(status), true);
  }
  assert.equal(isExecutionJobStatus("paused"), false);
  assert.equal(isExecutionJobStatus(42), false);
  assert.equal(isExecutionJobStatus(null), false);
});

test("LIFECYCLE: active vs terminal classification", () => {
  for (const status of ACTIVE_JOB_STATUSES) {
    assert.equal(isActiveJobStatus(status), true);
    assert.equal(isTerminalJobStatus(status), false);
  }
  for (const status of TERMINAL_JOB_STATUSES) {
    assert.equal(isTerminalJobStatus(status), true);
    assert.equal(isActiveJobStatus(status), false);
  }
});

test("LIFECYCLE: every documented valid transition is allowed", () => {
  const valid: [string, string][] = [
    ["pending", "queued"],
    ["pending", "failed"],
    ["pending", "cancelled"],
    ["queued", "running"],
    ["queued", "failed"],
    ["queued", "cancelled"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["failed", "queued"],
    ["failed", "cancelled"],
  ];
  for (const [from, to] of valid) {
    assert.equal(
      canTransitionJobStatus(from as never, to as never),
      true,
      `expected ${from} → ${to} to be allowed`
    );
    assert.doesNotThrow(() =>
      assertValidJobTransition(from as never, to as never)
    );
  }
});

test("LIFECYCLE: invalid transitions are rejected", () => {
  const invalid: [string, string][] = [
    ["pending", "running"],
    ["pending", "succeeded"],
    ["queued", "succeeded"],
    ["queued", "pending"],
    ["running", "queued"],
    ["running", "pending"],
    ["succeeded", "queued"],
    ["succeeded", "running"],
    ["cancelled", "queued"],
    ["cancelled", "failed"],
    ["failed", "running"],
    ["failed", "succeeded"],
  ];
  for (const [from, to] of invalid) {
    assert.equal(
      canTransitionJobStatus(from as never, to as never),
      false,
      `expected ${from} → ${to} to be rejected`
    );
    assert.throws(
      () => assertValidJobTransition(from as never, to as never),
      InvalidJobTransitionError
    );
  }
});

test("LIFECYCLE: self-transitions are rejected", () => {
  for (const status of EXECUTION_JOB_STATUSES) {
    assert.equal(canTransitionJobStatus(status, status), false);
    assert.throws(
      () => assertValidJobTransition(status, status),
      InvalidJobTransitionError
    );
  }
});

test("LIFECYCLE: unknown statuses cannot transition", () => {
  assert.equal(
    canTransitionJobStatus("pending" as never, "paused" as never),
    false
  );
  assert.equal(
    canTransitionJobStatus("paused" as never, "queued" as never),
    false
  );
});

test("LIFECYCLE: allowedTransitionsFrom matches the transition table", () => {
  assert.deepEqual([...allowedTransitionsFrom("pending")], [
    "queued",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual([...allowedTransitionsFrom("queued")], [
    "running",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual([...allowedTransitionsFrom("running")], [
    "succeeded",
    "failed",
    "cancelled",
  ]);
  assert.deepEqual([...allowedTransitionsFrom("failed")], [
    "queued",
    "cancelled",
  ]);
  assert.deepEqual([...allowedTransitionsFrom("succeeded")], []);
  assert.deepEqual([...allowedTransitionsFrom("cancelled")], []);
});

test("LIFECYCLE: invalid transition error preserves from/to", () => {
  const error = new InvalidJobTransitionError("succeeded", "queued");
  assert.equal(error.name, "InvalidJobTransitionError");
  assert.equal(error.from, "succeeded");
  assert.equal(error.to, "queued");
  assert.match(error.message, /succeeded → queued/);
});

test("LIFECYCLE: lifecycle timestamps are stamped per transition", () => {
  const now = new Date("2026-10-23T10:00:00Z");
  assert.deepEqual(lifecycleTimestampsForTransition("pending", now), {});
  assert.deepEqual(lifecycleTimestampsForTransition("queued", now), {
    queuedAt: now,
  });
  assert.deepEqual(lifecycleTimestampsForTransition("running", now), {
    startedAt: now,
  });
  assert.deepEqual(lifecycleTimestampsForTransition("succeeded", now), {
    finishedAt: now,
  });
  assert.deepEqual(lifecycleTimestampsForTransition("failed", now), {
    finishedAt: now,
  });
  assert.deepEqual(lifecycleTimestampsForTransition("cancelled", now), {
    finishedAt: now,
  });
});
