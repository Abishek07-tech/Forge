import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | LogValue[]
  | { [key: string]: LogValue };

export type LogContext = Record<string, LogValue>;

export interface LogRecord {
  timestamp: string;
  level: Exclude<LogLevel, "silent">;
  event: string;
  context: LogContext;
}

export interface LogSink {
  write(record: LogRecord): void;
}

const SECRET_KEY_PATTERN =
  /password|secret|token|credential|authorization|api[-_]?key|private[-_]?key|passwd|auth/i;

export const REDACTED = "[REDACTED]";

const MAX_REDACTION_DEPTH = 6;

export function redactSecrets(
  value: LogValue,
  depth = 0
): LogValue {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1));
  }
  const result: Record<string, LogValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactSecrets(item, depth + 1);
  }
  return result;
}

export function newCorrelationId(): string {
  return randomUUID();
}

export interface LoggerOptions {
  sink?: LogSink;
  level?: LogLevel;
  clock?: () => Date;
  context?: LogContext;
}

export interface Logger {
  readonly correlationId: string | undefined;
  child(context: LogContext): Logger;
  debug(event: string, context?: LogContext): void;
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

export const consoleSink: LogSink = {
  write(record: LogRecord): void {
    const line = JSON.stringify({
      timestamp: record.timestamp,
      level: record.level,
      event: record.event,
      ...record.context,
    });
    if (record.level === "error" || record.level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  },
};

export const silentSink: LogSink = {
  write(): void {
    /* intentionally produces no output */
  },
};

export function createInMemorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    write(record: LogRecord): void {
      records.push(record);
    },
  };
}

function emit(
  options: Required<Pick<LoggerOptions, "level" | "clock">> & {
    sink: LogSink;
    context: LogContext;
  },
  level: Exclude<LogLevel, "silent">,
  event: string,
  context?: LogContext
): void {
  try {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) {
      return;
    }
    const merged: LogContext = {
      ...options.context,
      ...(context ?? {}),
    };
    const safeContext = redactSecrets(merged);
    options.sink.write({
      timestamp: options.clock().toISOString(),
      level,
      event,
      context:
        typeof safeContext === "object" && safeContext !== null && !Array.isArray(safeContext)
          ? safeContext
          : { value: safeContext },
    });
  } catch {
    try {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "observability.write-failed",
          context: { originalEvent: event },
        })
      );
    } catch {
      // Observability failures must never crash the caller.
    }
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const sink = options.sink ?? consoleSink;
  const clock = options.clock ?? (() => new Date());
  const context = options.context ?? {};
  const correlationId =
    typeof context.correlationId === "string" ? context.correlationId : undefined;

  const build = (childContext: LogContext): Logger => ({
    correlationId,
    child(extra: LogContext): Logger {
      return build({ ...childContext, ...extra });
    },
    debug(event, eventContext) {
      emit({ level, sink, clock, context: childContext }, "debug", event, eventContext);
    },
    info(event, eventContext) {
      emit({ level, sink, clock, context: childContext }, "info", event, eventContext);
    },
    warn(event, eventContext) {
      emit({ level, sink, clock, context: childContext }, "warn", event, eventContext);
    },
    error(event, eventContext) {
      emit({ level, sink, clock, context: childContext }, "error", event, eventContext);
    },
  });

  return build(context);
}

export const defaultLogger: Logger = createLogger();

export function createTestLogger(
  level: LogLevel = "debug"
): { logger: Logger; records: LogRecord[] } {
  const sink = createInMemorySink();
  return {
    logger: createLogger({ sink, level }),
    records: sink.records,
  };
}
