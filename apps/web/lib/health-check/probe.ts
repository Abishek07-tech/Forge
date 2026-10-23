import type {
  HealthProbeOutcome,
  HealthProbeTarget,
} from "../../types/health-check.ts";

export interface HealthProbe {
  probe(target: HealthProbeTarget): Promise<HealthProbeOutcome>;
}

export function buildProbeUrl(target: HealthProbeTarget): string {
  const host = target.host.trim() === "" ? "127.0.0.1" : target.host;
  const authority =
    target.port === null || target.port === 80 || target.port === 443
      ? host
      : `${host}:${target.port}`;
  const path = target.path.startsWith("/") ? target.path : `/${target.path}`;
  return `${target.scheme}://${authority}${path}`;
}

function classifyFetchError(error: unknown): HealthProbeOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown })?.cause;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "";
  const name = error instanceof Error ? error.name : "";

  if (name === "TimeoutError" || name === "AbortError" || causeCode === "ABORT_ERR") {
    return {
      reachable: false,
      statusCode: null,
      latencyMs: null,
      errorKind: "timeout",
      errorMessage: "Health probe timed out.",
    };
  }
  if (
    causeCode === "ECONNREFUSED" ||
    causeCode === "ENOTFOUND" ||
    causeCode === "EHOSTUNREACH" ||
    causeCode === "ECONNRESET" ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed/i.test(message)
  ) {
    return {
      reachable: false,
      statusCode: null,
      latencyMs: null,
      errorKind: "connection-refused",
      errorMessage: "Health probe could not reach the target.",
    };
  }
  return {
    reachable: false,
    statusCode: null,
    latencyMs: null,
    errorKind: "network-error",
    errorMessage: "Health probe failed with an unexpected network error.",
  };
}

export function createHttpHealthProbe(fetchImpl: typeof fetch = fetch): HealthProbe {
  return {
    async probe(target: HealthProbeTarget): Promise<HealthProbeOutcome> {
      const url = buildProbeUrl(target);
      const startedAt = performance.now();
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          signal: AbortSignal.timeout(5_000),
          redirect: "manual",
        });
        const latencyMs = Math.round(performance.now() - startedAt);
        if (response.status >= 200 && response.status < 300) {
          return {
            reachable: true,
            statusCode: response.status,
            latencyMs,
            errorKind: null,
            errorMessage: null,
          };
        }
        return {
          reachable: false,
          statusCode: response.status,
          latencyMs,
          errorKind: "http-error",
          errorMessage: `Health endpoint responded with status ${response.status}.`,
        };
      } catch (error) {
        const outcome = classifyFetchError(error);
        return {
          ...outcome,
          latencyMs: Math.round(performance.now() - startedAt),
        };
      }
    },
  };
}

export interface StaticProbeBehavior {
  outcome?: HealthProbeOutcome;
  error?: Error;
  delayMs?: number;
}

export function createStaticHealthProbe(
  behavior: StaticProbeBehavior
): HealthProbe {
  return {
    async probe(): Promise<HealthProbeOutcome> {
      if (behavior.delayMs !== undefined && behavior.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
      }
      if (behavior.error) {
        throw behavior.error;
      }
      if (!behavior.outcome) {
        throw new Error("StaticHealthProbe was configured without an outcome.");
      }
      return behavior.outcome;
    },
  };
}

export const neverResolvingHealthProbe: HealthProbe = {
  probe(): Promise<HealthProbeOutcome> {
    return new Promise<HealthProbeOutcome>(() => {});
  },
};
