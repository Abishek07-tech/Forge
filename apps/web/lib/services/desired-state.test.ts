import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import type { DesiredState } from "../../types/desired-state.ts";
import { prisma } from "../prisma.ts";
import {
  deleteDesiredStatesForProject,
  DuplicateVersionError,
  InvalidProjectError,
} from "../persistence/desired-state.ts";
import {
  createDesiredState,
  DesiredStateConflictError,
  DesiredStateNotFoundError,
  DesiredStateServiceError,
  DesiredStateValidationFailedError,
  ensureValidDesiredState,
  getCurrentDesiredState,
  getDesiredStateByVersion,
  listDesiredStateVersions,
  retireDesiredState,
  updateDesiredState,
} from "./desired-state.ts";

const KEEP = process.env.W60_KEEP === "1";
const serviceProjectName = "w60-service-create";
const versionProjectName = "w62-service-versions";
const updateProjectName = "w63-service-update";
const retireProjectName = "w64-service-retire";

function buildState(): DesiredState {
  return {
    desiredStateId: "ds_w59_service_v1",
    projectId: "prj_w59_service",
    version: 1,
    createdAt: new Date("2026-09-26T00:00:00Z"),
    updatedAt: new Date("2026-09-26T00:00:00Z"),
    applications: { image: "forge-api:v2", port: 8080 },
    runtime: { replicas: 3 },
    resources: { cpu: "500m", memory: "512Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 2 },
    health: { path: "/health" },
  };
}

let serviceProjectId: string | undefined;
let versionProjectId: string | undefined;
let updateProjectId: string | undefined;
let retireProjectId: string | undefined;

before(async () => {
  const existing = await prisma.project.findFirst({
    where: { name: serviceProjectName },
  });
  serviceProjectId =
    existing?.id ??
    (
      await prisma.project.create({
        data: {
          name: serviceProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;

  const versionProject = await prisma.project.findFirst({
    where: { name: versionProjectName },
  });
  versionProjectId =
    versionProject?.id ??
    (
      await prisma.project.create({
        data: {
          name: versionProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;

  const updateProject = await prisma.project.findFirst({
    where: { name: updateProjectName },
  });
  updateProjectId =
    updateProject?.id ??
    (
      await prisma.project.create({
        data: {
          name: updateProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;

  const retireProject = await prisma.project.findFirst({
    where: { name: retireProjectName },
  });
  retireProjectId =
    retireProject?.id ??
    (
      await prisma.project.create({
        data: {
          name: retireProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;

  if (KEEP) {
    await deleteDesiredStatesForProject(serviceProjectId);
    await deleteDesiredStatesForProject(versionProjectId);
    await deleteDesiredStatesForProject(updateProjectId);
    await deleteDesiredStatesForProject(retireProjectId);
  }
});

after(async () => {
  try {
    if (
      !KEEP &&
      serviceProjectId &&
      versionProjectId &&
      updateProjectId &&
      retireProjectId
    ) {
      await deleteDesiredStatesForProject(serviceProjectId);
      await deleteDesiredStatesForProject(versionProjectId);
      await deleteDesiredStatesForProject(updateProjectId);
      await deleteDesiredStatesForProject(retireProjectId);
      await prisma.project.deleteMany({
        where: {
          name: {
            in: [
              serviceProjectName,
              versionProjectName,
              updateProjectName,
              retireProjectName,
            ],
          },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("a valid domain object passes the service validation gate", () => {
  const state = buildState();
  assert.doesNotThrow(() => ensureValidDesiredState(state));
  const typed: DesiredState = state;
  assert.equal(typed.desiredStateId, "ds_w59_service_v1");
});

test("an invalid domain object is rejected with VALIDATION_FAILED", () => {
  const invalid = { desiredStateId: "ds_x" };
  assert.throws(
    () => ensureValidDesiredState(invalid),
    (error: unknown) => {
      assert.ok(error instanceof DesiredStateValidationFailedError);
      assert.ok(error instanceof DesiredStateServiceError);
      assert.equal((error as DesiredStateValidationFailedError).code, "VALIDATION_FAILED");
      const errors = (error as DesiredStateValidationFailedError).validationErrors;
      assert.ok(errors.length >= 1);
      const paths = errors.map((e) => e.path);
      assert.ok(paths.includes("projectId"));
      assert.ok(paths.includes("version"));
      assert.ok(paths.includes("applications"));
      assert.ok(paths.includes("runtime"));
      assert.ok(paths.includes("resources"));
      assert.ok(paths.includes("health"));
      return true;
    }
  );
});

test("each validation failure carries path and message", () => {
  const invalid = { runtime: { replicas: 0 } };
  try {
    ensureValidDesiredState(invalid);
    assert.fail("expected DesiredStateValidationFailedError");
  } catch (error) {
    assert.ok(error instanceof DesiredStateValidationFailedError);
    const first = error.validationErrors[0];
    assert.equal(first.path, "desiredStateId");
    assert.ok(first.message.length > 0);
    assert.ok(
      error.validationErrors.some(
        (e) => e.path === "runtime.replicas" && e.message.includes("replicas")
      )
    );
  }
});

test("non-object input is rejected by the gate", () => {
  assert.throws(() => ensureValidDesiredState("not-a-state"));
  assert.throws(() => ensureValidDesiredState(null));
  assert.throws(() => ensureValidDesiredState([buildState()]));
});

test("service error surface exposes persistence boundary errors", () => {
  assert.equal(DesiredStateServiceError.name, "DesiredStateServiceError");
  const persistenceOnly = new InvalidProjectError("test");
  assert.ok(persistenceOnly instanceof Error);
  assert.equal(persistenceOnly.code, "INVALID_PROJECT");
  const duplicate = new DuplicateVersionError("test");
  assert.equal(duplicate.code, "DUPLICATE_VERSION");
});

test("CREATE: valid state is validated, persisted, and returned as domain object", async () => {
  assert.ok(serviceProjectId);
  const state: DesiredState = {
    ...buildState(),
    desiredStateId: "ds_w60_service_create_v1",
    projectId: serviceProjectId,
    version: 1,
  };

  const result = await createDesiredState(state);

  assert.equal(result.desiredStateId, "ds_w60_service_create_v1");
  assert.equal(result.projectId, serviceProjectId);
  assert.equal(result.version, 1);
  assert.deepEqual(result.applications, state.applications);
  assert.deepEqual(result.runtime, state.runtime);
  assert.deepEqual(result.resources, state.resources);
  assert.deepEqual(result.environment, state.environment);
  assert.deepEqual(result.deployment, state.deployment);
  assert.deepEqual(result.health, state.health);
  assert.ok(result.createdAt instanceof Date);
  assert.ok(result.updatedAt instanceof Date);
});

test("CREATE: invalid state is rejected before persistence", async () => {
  const invalid = {
    ...buildState(),
    runtime: { replicas: 0 },
  };

  await assert.rejects(createDesiredState(invalid as DesiredState), (error: unknown) => {
    assert.ok(error instanceof DesiredStateValidationFailedError);
    assert.equal((error as DesiredStateValidationFailedError).code, "VALIDATION_FAILED");
    assert.ok(
      (error as DesiredStateValidationFailedError).validationErrors.some(
        (e) => e.path === "runtime.replicas"
      )
    );
    return true;
  });

  const rows = await prisma.desiredState.findFirst({
    where: { projectId: serviceProjectId, desiredStateId: "ds_w59_service_v1" },
  });
  assert.equal(rows, null);
});

test("CREATE: invalid state with unknown project still fails validation first", async () => {
  const invalid = {
    desiredStateId: "ds_w60_orphan",
    projectId: "prj_w60_does_not_exist",
  };

  await assert.rejects(createDesiredState(invalid as DesiredState), (error: unknown) => {
    assert.ok(error instanceof DesiredStateValidationFailedError);
    return true;
  });
});

test("CREATE: valid state for unknown project surfaces InvalidProjectError", async () => {
  const orphan = {
    ...buildState(),
    desiredStateId: "ds_w60_orphan_valid",
    projectId: "prj_w60_does_not_exist",
    version: 1,
  };

  await assert.rejects(createDesiredState(orphan), (error: unknown) => {
    assert.ok(error instanceof InvalidProjectError);
    assert.equal((error as InvalidProjectError).code, "INVALID_PROJECT");
    return true;
  });
});

test("CREATE: duplicate version surfaces DuplicateVersionError", async () => {
  assert.ok(serviceProjectId);
  const duplicate: DesiredState = {
    ...buildState(),
    desiredStateId: "ds_w60_service_duplicate_v1",
    projectId: serviceProjectId,
    version: 1,
  };

  await assert.rejects(createDesiredState(duplicate), (error: unknown) => {
    assert.ok(error instanceof DuplicateVersionError);
    assert.equal((error as DuplicateVersionError).code, "DUPLICATE_VERSION");
    return true;
  });
});

test("CREATE: duplicate desiredStateId surfaces DesiredStateConflictError", async () => {
  assert.ok(serviceProjectId);
  const duplicateId: DesiredState = {
    ...buildState(),
    desiredStateId: "ds_w60_service_create_v1",
    projectId: serviceProjectId,
    version: 2,
  };

  await assert.rejects(createDesiredState(duplicateId), (error: unknown) => {
    assert.ok(error instanceof DesiredStateConflictError);
    assert.equal((error as DesiredStateConflictError).code, "CONFLICT");
    return true;
  });
});

test("CREATE: persistence boundary is used, not direct Prisma access", async () => {
  assert.ok(serviceProjectId);
  const stored = await prisma.desiredState.findUnique({
    where: {
      projectId_version: { projectId: serviceProjectId, version: 1 },
    },
  });
  assert.ok(stored);
  assert.equal(stored.desiredStateId, "ds_w60_service_create_v1");
  const data = stored.data as { runtime?: { replicas?: number } };
  assert.equal(data.runtime?.replicas, 3);
});

test("READ: current Desired State is returned as a domain object", async () => {
  assert.ok(serviceProjectId);
  const current = await getCurrentDesiredState(serviceProjectId);

  assert.ok(current);
  assert.equal(current.desiredStateId, "ds_w60_service_create_v1");
  assert.equal(current.projectId, serviceProjectId);
  assert.equal(current.version, 1);
  assert.deepEqual(current.applications, { image: "forge-api:v2", port: 8080 });
  assert.deepEqual(current.runtime, { replicas: 3 });
  assert.deepEqual(current.resources, { cpu: "500m", memory: "512Mi" });
  assert.deepEqual(current.environment, { NODE_ENV: "production" });
  assert.deepEqual(current.deployment, { version: 2 });
  assert.deepEqual(current.health, { path: "/health" });
  assert.ok(current.createdAt instanceof Date);
  assert.ok(current.updatedAt instanceof Date);
});

test("READ: not-found project resolves to null", async () => {
  assert.equal(await getCurrentDesiredState("prj_w61_does_not_exist"), null);
});

test("READ: no Prisma objects are exposed in the returned domain object", async () => {
  assert.ok(serviceProjectId);
  const current = await getCurrentDesiredState(serviceProjectId);
  assert.ok(current);
  const keys = Object.keys(current).sort();
  assert.deepEqual(keys, [
    "applications",
    "createdAt",
    "deployment",
    "desiredStateId",
    "environment",
    "health",
    "projectId",
    "resources",
    "runtime",
    "updatedAt",
    "version",
  ]);
});

test("VERSION: v1 and v2 are stored as separate immutable snapshots", async () => {
  assert.ok(versionProjectId);
  const existingV1 = await getDesiredStateByVersion(versionProjectId, 1);
  if (!existingV1) {
    await createDesiredState({
      ...buildState(),
      desiredStateId: "ds_w62_versions_v1",
      projectId: versionProjectId,
      version: 1,
    });
  }
  const existingV2 = await getDesiredStateByVersion(versionProjectId, 2);
  if (!existingV2) {
    await createDesiredState({
      ...buildState(),
      desiredStateId: "ds_w62_versions_v2",
      projectId: versionProjectId,
      version: 2,
      applications: { image: "forge-api:v3", port: 9090 },
      runtime: { replicas: 5 },
    });
  }

  const v1 = await getDesiredStateByVersion(versionProjectId, 1);
  assert.ok(v1);
  assert.equal(v1.desiredStateId, "ds_w62_versions_v1");
  assert.equal(v1.version, 1);
  assert.deepEqual(v1.applications, { image: "forge-api:v2", port: 8080 });
  assert.deepEqual(v1.runtime, { replicas: 3 });

  const v2 = await getDesiredStateByVersion(versionProjectId, 2);
  assert.ok(v2);
  assert.equal(v2.desiredStateId, "ds_w62_versions_v2");
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.applications, { image: "forge-api:v3", port: 9090 });
  assert.deepEqual(v2.runtime, { replicas: 5 });
});

test("VERSION: list returns all versions in ascending order", async () => {
  assert.ok(versionProjectId);
  const history = await listDesiredStateVersions(versionProjectId);
  assert.deepEqual(
    history.map((state) => state.version),
    [1, 2]
  );
  assert.ok(history.every((state) => state.projectId === versionProjectId));
});

test("VERSION: current Desired State is the highest version", async () => {
  assert.ok(versionProjectId);
  const current = await getCurrentDesiredState(versionProjectId);
  assert.ok(current);
  assert.equal(current.version, 2);
  assert.equal(current.desiredStateId, "ds_w62_versions_v2");
});

test("VERSION: missing version resolves to null", async () => {
  assert.ok(versionProjectId);
  assert.equal(await getDesiredStateByVersion(versionProjectId, 999), null);
  assert.equal(
    await getDesiredStateByVersion("prj_w62_does_not_exist", 1),
    null
  );
  assert.equal(await getDesiredStateByVersion(versionProjectId, 0), null);
});

test("UPDATE: appends a new version with the client-declared desiredStateId", async () => {
  assert.ok(updateProjectId);
  await createDesiredState({
    ...buildState(),
    desiredStateId: "ds_w63_update_v1",
    projectId: updateProjectId,
    version: 1,
  });

  const updated = await updateDesiredState(updateProjectId, {
    ...buildState(),
    desiredStateId: "ds_w63_update_v2",
    projectId: updateProjectId,
    version: 99,
    applications: { image: "forge-api:v4", port: 9090 },
    runtime: { replicas: 5 },
  });

  assert.equal(updated.version, 2);
  assert.equal(updated.desiredStateId, "ds_w63_update_v2");
  assert.equal(updated.projectId, updateProjectId);
  assert.deepEqual(updated.applications, { image: "forge-api:v4", port: 9090 });
  assert.deepEqual(updated.runtime, { replicas: 5 });
  assert.ok(updated.createdAt instanceof Date);
  assert.ok(updated.updatedAt instanceof Date);
});

test("UPDATE: previous version is preserved and current moves forward", async () => {
  assert.ok(updateProjectId);
  const history = await listDesiredStateVersions(updateProjectId);
  assert.deepEqual(
    history.map((state) => state.version),
    [1, 2]
  );

  const v1 = await getDesiredStateByVersion(updateProjectId, 1);
  assert.ok(v1);
  assert.equal(v1.desiredStateId, "ds_w63_update_v1");
  assert.deepEqual(v1.applications, { image: "forge-api:v2", port: 8080 });
  assert.deepEqual(v1.runtime, { replicas: 3 });

  const current = await getCurrentDesiredState(updateProjectId);
  assert.ok(current);
  assert.equal(current.version, 2);
  assert.equal(current.desiredStateId, "ds_w63_update_v2");
  assert.deepEqual(current.applications, { image: "forge-api:v4", port: 9090 });
});

test("UPDATE: re-using the current desiredStateId surfaces DesiredStateConflictError", async () => {
  assert.ok(updateProjectId);
  await assert.rejects(
    updateDesiredState(updateProjectId, {
      ...buildState(),
      desiredStateId: "ds_w63_update_v2",
      projectId: updateProjectId,
      version: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesiredStateConflictError);
      assert.ok(error instanceof DesiredStateServiceError);
      assert.equal(
        (error as DesiredStateConflictError).code,
        "CONFLICT"
      );
      return true;
    }
  );

  const history = await listDesiredStateVersions(updateProjectId);
  assert.deepEqual(
    history.map((state) => state.version),
    [1, 2]
  );
});

test("UPDATE: project with no Desired State raises DesiredStateNotFoundError", async () => {
  assert.ok(updateProjectId);
  await assert.rejects(
    updateDesiredState("prj_w63_empty", {
      ...buildState(),
      projectId: "prj_w63_empty",
      version: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesiredStateNotFoundError);
      assert.equal((error as DesiredStateNotFoundError).code, "NOT_FOUND");
      return true;
    }
  );
});

test("UPDATE: invalid new state is rejected before persistence", async () => {
  assert.ok(updateProjectId);
  await assert.rejects(
    updateDesiredState(updateProjectId, {
      ...buildState(),
      projectId: updateProjectId,
      runtime: { replicas: 0 },
    } as DesiredState),
    (error: unknown) => {
      assert.ok(error instanceof DesiredStateValidationFailedError);
      assert.equal(
        (error as DesiredStateValidationFailedError).code,
        "VALIDATION_FAILED"
      );
      return true;
    }
  );

  const history = await listDesiredStateVersions(updateProjectId);
  assert.deepEqual(
    history.map((state) => state.version),
    [1, 2]
  );
});

test("UPDATE: projectId from the path parameter wins over the body", async () => {
  assert.ok(updateProjectId);
  const updated = await updateDesiredState(updateProjectId, {
    ...buildState(),
    desiredStateId: "ds_w63_update_v3",
    projectId: "prj_w63_wrong_project",
    version: 1,
    applications: { image: "forge-api:v5", port: 9090 },
    runtime: { replicas: 2 },
  });

  assert.equal(updated.projectId, updateProjectId);
  assert.equal(updated.version, 3);
  assert.equal(updated.desiredStateId, "ds_w63_update_v3");

  const wrongProjectState = await prisma.desiredState.findFirst({
    where: { projectId: "prj_w63_wrong_project" },
  });
  assert.equal(wrongProjectState, null);
});

test("UPDATE: Project relationship remains correct after update", async () => {
  assert.ok(updateProjectId);
  const history = await listDesiredStateVersions(updateProjectId);
  assert.ok(history.length >= 2);
  assert.ok(
    history.every((state) => state.projectId === updateProjectId)
  );
  const project = await prisma.project.findUnique({
    where: { id: updateProjectId },
  });
  assert.ok(project);
  const desiredStates = await prisma.desiredState.findMany({
    where: { projectId: updateProjectId },
  });
  assert.equal(desiredStates.length, history.length);
  assert.ok(
    desiredStates.every((row) => row.projectId === project.id)
  );
});

test("RETIRE: successful retirement returns the decision and deletes nothing", async () => {
  assert.ok(retireProjectId);
  await createDesiredState({
    ...buildState(),
    desiredStateId: "ds_w64_retire_v1",
    projectId: retireProjectId,
    version: 1,
  });
  await updateDesiredState(retireProjectId, {
    ...buildState(),
    desiredStateId: "ds_w64_retire_v2",
    projectId: retireProjectId,
    version: 1,
    runtime: { replicas: 4 },
  });

  const retirement = await retireDesiredState(retireProjectId);

  assert.equal(retirement.projectId, retireProjectId);
  assert.equal(retirement.desiredStateId, "ds_w64_retire_v2");
  assert.equal(retirement.version, 2);
  assert.equal(retirement.retainedVersions, 2);

  const rows = await prisma.desiredState.findMany({
    where: { projectId: retireProjectId },
  });
  assert.equal(rows.length, 2);
});

test("RETIRE: repeated retirement is idempotent", async () => {
  assert.ok(retireProjectId);
  const first = await retireDesiredState(retireProjectId);
  const second = await retireDesiredState(retireProjectId);

  assert.deepEqual(second, first);

  const rows = await prisma.desiredState.findMany({
    where: { projectId: retireProjectId },
  });
  assert.equal(rows.length, 2);
});

test("RETIRE: historical versions are preserved after retirement", async () => {
  assert.ok(retireProjectId);
  const history = await listDesiredStateVersions(retireProjectId);
  assert.deepEqual(
    history.map((state) => state.version),
    [1, 2]
  );

  const v1 = await getDesiredStateByVersion(retireProjectId, 1);
  assert.ok(v1);
  assert.equal(v1.desiredStateId, "ds_w64_retire_v1");
  assert.deepEqual(v1.runtime, { replicas: 3 });

  const current = await getCurrentDesiredState(retireProjectId);
  assert.ok(current);
  assert.equal(current.desiredStateId, "ds_w64_retire_v2");
  assert.deepEqual(current.runtime, { replicas: 4 });
});

test("RETIRE: missing Desired State raises DesiredStateNotFoundError", async () => {
  await assert.rejects(
    retireDesiredState("prj_w64_does_not_exist"),
    (error: unknown) => {
      assert.ok(error instanceof DesiredStateNotFoundError);
      assert.equal((error as DesiredStateNotFoundError).code, "NOT_FOUND");
      return true;
    }
  );
});

test("RETIRE: invalid projectId is rejected", async () => {
  await assert.rejects(retireDesiredState(""), (error: unknown) => {
    assert.ok(error instanceof DesiredStateServiceError);
    assert.equal((error as DesiredStateServiceError).code, "VALIDATION_FAILED");
    return true;
  });
  await assert.rejects(
    retireDesiredState(null as unknown as string),
    (error: unknown) => {
      assert.ok(error instanceof DesiredStateServiceError);
      assert.equal(
        (error as DesiredStateServiceError).code,
        "VALIDATION_FAILED"
      );
      return true;
    }
  );
});

test("RETIRE: Project row is never deleted and other projects are isolated", async () => {
  assert.ok(retireProjectId);
  assert.ok(serviceProjectId);

  await retireDesiredState(retireProjectId);

  const project = await prisma.project.findUnique({
    where: { id: retireProjectId },
  });
  assert.ok(project);
  assert.equal(project.name, retireProjectName);

  const serviceRows = await prisma.desiredState.findMany({
    where: { projectId: serviceProjectId },
  });
  assert.ok(serviceRows.length >= 1);
  assert.ok(serviceRows.every((row) => row.projectId === serviceProjectId));
});
