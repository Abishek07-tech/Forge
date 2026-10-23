import { defaultLogger, type Logger } from "../observability/logger.ts";
import {
  classifyFailure,
  type ClassifiedFailure,
  type FailureDisposition,
} from "./classify.ts";

export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  failure: ClassifiedFailure;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  deadlineMs?: number;
  classify?: (error: unknown) => ClassifiedFailure;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (info: RetryAttemptInfo) => void;
  logger?: Logger;
  operationName?: string;
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  readonly lastDisposition: FailureDisposition;
  readonly timedOut: boolean;
  readonly totalDelayMs: number;

  constructor(
    operationName: string,
    attempts: number,
    lastError: unknown,
    lastDisposition: FailureDisposition,
    timedOut: boolean,
    totalDelayMs: number
  ) {
    const causeMessage =
      lastError instanceof Error ? lastError.message : String(lastError);
    super(
      `Operation "${operationName}" failed after ${attempts} attempt(s)${
        timedOut ? " (deadline exceeded)" : ""
      }: ${causeMessage}`
    );
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
    this.lastDisposition = lastDisposition;
    this.timedOut = timedOut;
    this.totalDelayMs = totalDelayMs;
  }
}

export const DEFAULT_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
} as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(maxDelayMs, Math.max(0, exponential));
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs);
  const deadlineMs = options.deadlineMs;
  const classify = options.classify ?? classifyFailure;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const operationName = options.operationName ?? "operation";
  const logger = (options.logger ?? defaultLogger).child({
    component: "resilience",
    operationName,
  });

  const startedAt = now();
  let lastError: unknown;
  let lastDisposition: FailureDisposition = "retryable";
  let totalDelayMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const failure = classify(error);
      lastError = error;
      lastDisposition = failure.disposition;

      if (failure.disposition !== "retryable") {
        logger.warn("resilience.failure.permanent", {
          attempt,
          disposition: failure.disposition,
          errorName: failure.errorName,
          errorMessage: failure.message,
        });
        throw error;
      }

      if (attempt >= maxAttempts) {
        break;
      }

      const delayMs = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs);
      const elapsedMs = now() - startedAt;
      if (deadlineMs !== undefined && elapsedMs + delayMs > deadlineMs) {
        throw new RetryExhaustedError(
          operationName,
          attempt,
          error,
          failure.disposition,
          true,
          totalDelayMs
        );
      }

      logger.warn("resilience.retry.scheduled", {
        attempt,
        nextDelayMs: delayMs,
        disposition: failure.disposition,
        errorName: failure.errorName,
        errorMessage: failure.message,
      });
      options.onRetry?.({ attempt, delayMs, failure });
      totalDelayMs += delayMs;
      await sleep(delayMs);
    }
  }

  logger.error("resilience.retry.exhausted", {
    attempts: maxAttempts,
    disposition: lastDisposition,
    totalDelayMs,
  });
  throw new RetryExhaustedError(
    operationName,
    maxAttempts,
    lastError,
    lastDisposition,
    false,
    totalDelayMs
  );
}
