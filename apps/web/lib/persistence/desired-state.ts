import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../prisma.ts";
import type {
  Application,
  Deployment,
  DesiredState,
  Environment,
  Health,
  Resources,
  Runtime,
} from "../../types/desired-state.ts";

export interface DesiredStatePayload {
  applications: Application;
  runtime: Runtime;
  resources: Resources;
  environment?: Environment;
  deployment?: Deployment;
  health: Health;
}

export type DesiredStatePersistenceErrorCode =
  | "INVALID_PROJECT"
  | "DUPLICATE_VERSION";

export class DesiredStatePersistenceError extends Error {
  readonly code: DesiredStatePersistenceErrorCode;
  readonly causeError: unknown;

  constructor(
    code: DesiredStatePersistenceErrorCode,
    message: string,
    causeError?: unknown
  ) {
    super(message);
    this.name = "DesiredStatePersistenceError";
    this.code = code;
    this.causeError = causeError;
  }
}

export class InvalidProjectError extends DesiredStatePersistenceError {
  constructor(message: string, causeError?: unknown) {
    super("INVALID_PROJECT", message, causeError);
    this.name = "InvalidProjectError";
  }
}

export class DuplicateVersionError extends DesiredStatePersistenceError {
  constructor(message: string, causeError?: unknown) {
    super("DUPLICATE_VERSION", message, causeError);
    this.name = "DuplicateVersionError";
  }
}

type PrismaDesiredState = Prisma.DesiredStateModel;

function toPayload(input: DesiredState): Prisma.InputJsonValue {
  const payload: DesiredStatePayload = {
    applications: input.applications,
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

function toDomain(row: PrismaDesiredState): DesiredState {
  return {
    desiredStateId: row.desiredStateId,
    projectId: row.projectId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.data as unknown as DesiredStatePayload),
  };
}

function isVersionUniqueViolation(
  error: Prisma.PrismaClientKnownRequestError
): boolean {
  const meta = error.meta as
    | {
        target?: unknown;
        driverAdapterError?: {
          cause?: { constraint?: { index?: string } };
        };
      }
    | undefined;
  const target = meta?.target;
  if (Array.isArray(target) && target.includes("projectId_version")) {
    return true;
  }
  return meta?.driverAdapterError?.cause?.constraint?.index ===
    "DesiredState_projectId_version_key";
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2003") {
      throw new InvalidProjectError(
        "The referenced project does not exist.",
        error
      );
    }
    if (error.code === "P2002" && isVersionUniqueViolation(error)) {
      throw new DuplicateVersionError(
        "A Desired State with this version already exists for the project.",
        error
      );
    }
  }
  throw error instanceof Error ? error : new Error(String(error));
}

export async function createDesiredState(
  input: DesiredState
): Promise<DesiredState> {
  try {
    const row = await prisma.desiredState.create({
      data: {
        desiredStateId: input.desiredStateId,
        projectId: input.projectId,
        version: input.version,
        data: toPayload(input),
      },
    });
    return toDomain(row);
  } catch (error) {
    mapPersistenceError(error);
  }
}

export async function getCurrentDesiredState(
  projectId: string
): Promise<DesiredState | null> {
  const row = await prisma.desiredState.findFirst({
    where: { projectId },
    orderBy: { version: "desc" },
  });
  return row ? toDomain(row) : null;
}

export async function getDesiredStateByVersion(
  projectId: string,
  version: number
): Promise<DesiredState | null> {
  const row = await prisma.desiredState.findUnique({
    where: { projectId_version: { projectId, version } },
  });
  return row ? toDomain(row) : null;
}

export async function listDesiredStateVersions(
  projectId: string
): Promise<DesiredState[]> {
  const rows = await prisma.desiredState.findMany({
    where: { projectId },
    orderBy: { version: "asc" },
  });
  return rows.map(toDomain);
}

export async function deleteDesiredStatesForProject(
  projectId: string
): Promise<void> {
  await prisma.desiredState.deleteMany({ where: { projectId } });
}