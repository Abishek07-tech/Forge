import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateExecutionJobDraft } from "./execution-job.ts";

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job_w93_1",
    projectId: "prj_1",
    workloadId: "default",
    desiredState: { desiredStateId: "ds_1", version: 3 },
    jobType: "reconcile",
    status: "pending",
    idempotencyKey: "reconcile:prj_1:default:ds_1",
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

test("VALIDATION: a valid draft is accepted", () => {
  const result = validateExecutionJobDraft(validDraft());
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.job);
  assert.equal(result.job?.jobId, "job_w93_1");
  assert.deepEqual(result.job?.desiredState, {
    desiredStateId: "ds_1",
    version: 3,
  });
  assert.equal(result.job?.jobType, "reconcile");
  assert.equal(result.job?.status, "pending");
});

test("VALIDATION: optional correlationId and failure are preserved", () => {
  const occurredAt = new Date("2026-10-23T10:00:00Z");
  const result = validateExecutionJobDraft(
    validDraft({
      correlationId: "corr_1",
      failure: { kind: "persistence", message: "boom", code: "PERSISTENCE_FAILED", occurredAt },
    })
  );
  assert.equal(result.valid, true);
  assert.equal(result.job?.correlationId, "corr_1");
  assert.equal(result.job?.failure?.kind, "persistence");
  assert.equal(result.job?.failure?.message, "boom");
  assert.equal(result.job?.failure?.code, "PERSISTENCE_FAILED");
  assert.equal(result.job?.failure?.occurredAt, occurredAt);
});

test("VALIDATION: non-object input fails", () => {
  for (const bad of [null, undefined, 42, "job", []]) {
    const result = validateExecutionJobDraft(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test("VALIDATION: missing required fields are reported together", () => {
  const result = validateExecutionJobDraft({});
  assert.equal(result.valid, false);
  const paths = result.errors.map((error) => error.path);
  for (const path of [
    "jobId",
    "projectId",
    "workloadId",
    "idempotencyKey",
    "desiredState",
    "jobType",
    "status",
    "attemptCount",
    "maxAttempts",
  ]) {
    assert.ok(paths.includes(path), `expected error for ${path}`);
  }
});

test("VALIDATION: empty strings are rejected", () => {
  const result = validateExecutionJobDraft(
    validDraft({ jobId: "  ", workloadId: "" })
  );
  assert.equal(result.valid, false);
  const paths = result.errors.map((error) => error.path);
  assert.ok(paths.includes("jobId"));
  assert.ok(paths.includes("workloadId"));
});

test("VALIDATION: invalid jobType and status enums are rejected", () => {
  const result = validateExecutionJobDraft(
    validDraft({ jobType: "explode", status: "paused" })
  );
  assert.equal(result.valid, false);
  const paths = result.errors.map((error) => error.path);
  assert.ok(paths.includes("jobType"));
  assert.ok(paths.includes("status"));
});

test("VALIDATION: desiredState must reference an id and positive integer version", () => {
  const missing = validateExecutionJobDraft(validDraft({ desiredState: {} }));
  assert.equal(missing.valid, false);
  const missingPaths = missing.errors.map((error) => error.path);
  assert.ok(missingPaths.includes("desiredState.desiredStateId"));
  assert.ok(missingPaths.includes("desiredState.version"));

  const badVersion = validateExecutionJobDraft(
    validDraft({ desiredState: { desiredStateId: "ds_1", version: 0 } })
  );
  assert.equal(badVersion.valid, false);

  const nonInteger = validateExecutionJobDraft(
    validDraft({ desiredState: { desiredStateId: "ds_1", version: 1.5 } })
  );
  assert.equal(nonInteger.valid, false);

  const notObject = validateExecutionJobDraft(validDraft({ desiredState: "ds_1" }));
  assert.equal(notObject.valid, false);
});

test("VALIDATION: attemptCount and maxAttempts bounds are enforced", () => {
  const negative = validateExecutionJobDraft(validDraft({ attemptCount: -1 }));
  assert.equal(negative.valid, false);

  const zeroMax = validateExecutionJobDraft(validDraft({ maxAttempts: 0 }));
  assert.equal(zeroMax.valid, false);

  const tooMany = validateExecutionJobDraft(validDraft({ maxAttempts: 11 }));
  assert.equal(tooMany.valid, false);
});

test("VALIDATION: invalid failure objects are rejected", () => {
  const result = validateExecutionJobDraft(
    validDraft({ failure: { kind: "", message: "", occurredAt: "not-a-date" } })
  );
  assert.equal(result.valid, false);
  const paths = result.errors.map((error) => error.path);
  assert.ok(paths.includes("failure.kind"));
  assert.ok(paths.includes("failure.message"));
  assert.ok(paths.includes("failure.occurredAt"));
});

test("VALIDATION: invalid correlationId is rejected", () => {
  const result = validateExecutionJobDraft(validDraft({ correlationId: " " }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === "correlationId"));
});
