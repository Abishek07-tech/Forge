import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../prisma.ts";
import type {
  ActualStateObservation,
  ObservedApplication,
  ObservedDeployment,
  ObservedHealth,
  ObservedResources,
  ObservedRuntime,
  ObservedStatus,
  Environment,
} from "../../types/actual-state.ts";

export interface ActualStatePayload {
  application: ObservedApplication;
  runtime: ObservedRuntime;
  resources: ObservedResources;
  health: ObservedHealth;
  environment?: Environment;
  deployment?: ObservedDeployment;
}

export type ActualStatePersistenceErrorCode = "INVALID_PROJECT";

export class ActualStatePersistenceError extends Error {
  readonly code: ActualStatePersistenceErrorCode;
  readonly causeError: unknown;

  constructor(
    code: ActualStatePersistenceErrorCode,
    message: string,
    causeError?: unknown
  ) {
    super(message);
    this.name = "ActualStatePersistenceError";
    this.code = code;
    this.causeError = causeError;
  }
}

export class InvalidProjectError extends ActualStatePersistenceError {
  constructor(message: string, causeError?: unknown) {
    super("INVALID_PROJECT", message, causeError);
    this.name = "InvalidProjectError";
  }
}

type PrismaObservation = Prisma.ActualStateObservationModel;

function toPayload(input: ActualStateObservation): Prisma.InputJsonValue {
  const payload: ActualStatePayload = {
    application: input.application,
    runtime: input.runtime,
    resources: input.resources,
    health: input.health,
  };
  if (input.environment !== undefined) {
    payload.environment = input.environment;
  }
  if (input.deployment !== undefined) {
    payload.deployment = input.deployment;
  }
  return payload as unknown as Prisma.InputJsonValue;
}

function toDomain(row: PrismaObservation): ActualStateObservation {
  return {
    observationId: row.observationId,
    projectId: row.projectId,
    workloadId: row.workloadId,
    source: row.source,
    observedAt: row.observedAt,
    status: row.status as ObservedStatus,
    ...(row.data as unknown as ActualStatePayload),
  };
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2003") {
      throw new InvalidProjectError(
        "The referenced project does not exist.",
        error
      );
    }
  }
  throw error instanceof Error ? error : new Error(String(error));
}

export async function createObservation(
  input: ActualStateObservation
): Promise<ActualStateObservation> {
  try {
    const row = await prisma.actualStateObservation.create({
      data: {
        observationId: input.observationId,
        projectId: input.projectId,
        workloadId: input.workloadId,
        source: input.source,
        observedAt: input.observedAt,
        status: input.status,
        data: toPayload(input),
      },
    });
    return toDomain(row);
  } catch (error) {
    mapPersistenceError(error);
  }
}

export async function getLatestObservation(
  projectId: string,
  workloadId: string
): Promise<ActualStateObservation | null> {
  const row = await prisma.actualStateObservation.findFirst({
    where: { projectId, workloadId },
    orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }],
  });
  return row ? toDomain(row) : null;
}

export async function listObservations(
  projectId: string,
  workloadId: string
): Promise<ActualStateObservation[]> {
  const rows = await prisma.actualStateObservation.findMany({
    where: { projectId, workloadId },
    orderBy: [{ observedAt: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDomain);
}

export async function deleteObservationsForProject(
  projectId: string
): Promise<void> {
  await prisma.actualStateObservation.deleteMany({ where: { projectId } });
}
