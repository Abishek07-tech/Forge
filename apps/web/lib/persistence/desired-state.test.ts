import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { prisma } from "../prisma.ts";
import { validateDesiredState } from "../validation/desired-state.ts";
import {
  createDesiredState,
  deleteDesiredStatesForProject,
  DuplicateVersionError,
  getCurrentDesiredState,
  getDesiredStateByVersion,
  InvalidProjectError,
  listDesiredStateVersions,
} from "./desired-state.ts";
import type { DesiredState } from "../../types/desired-state.ts";

const KEEP = process.env.W57_KEEP === "1";
const integrationProjectName = "w57-persistence-integration";
const isolationProjectName = "w57-persistence-isolation";

function buildState(
  projectId: string,
  version: number,
  desiredStateId: string
): DesiredState {
  return {
    desiredStateId,
    projectId,
    version,
    createdAt: new Date("2026-09-25T00:00:00Z"),
    updatedAt: new Date("2026-09-25T00:00:00Z"),
    applications: { image: "forge-api:v2", port: 8080 },
    runtime: { replicas: 3 },
    resources: { cpu: "500m", memory: "512Mi" },
    environment: { NODE_ENV: "production" },
    deployment: { version: 2 },
    health: { path: "/health" },
  };
}

let integrationProjectId: string | undefined;
let isolationProjectId: string | undefined;
let created: DesiredState | undefined;

before(async () => {
  const integration = await prisma.project.findFirst({
    where: { name: integrationProjectName },
  });
  integrationProjectId =
    integration?.id ??
    (
      await prisma.project.create({
        data: {
          name: integrationProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;

  const isolation = await prisma.project.findFirst({
    where: { name: isolationProjectName },
  });
  isolationProjectId =
    isolation?.id ??
    (
      await prisma.project.create({
        data: {
          name: isolationProjectName,
          status: "stopped",
          deployments: 0,
        },
      })
    ).id;

  if (KEEP) {
    await deleteDesiredStatesForProject(integrationProjectId);
    await deleteDesiredStatesForProject(isolationProjectId);
  }
});

after(async () => {
  try {
    if (!KEEP && integrationProjectId && isolationProjectId) {
      await deleteDesiredStatesForProject(integrationProjectId);
      await deleteDesiredStatesForProject(isolationProjectId);
      await prisma.project.deleteMany({
        where: {
          name: { in: [integrationProjectName, isolationProjectName] },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("domain object satisfies Work 52 validation", () => {
  const result = validateDesiredState(
    buildState("irrelevant", 1, "ds_validation")
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("createDesiredState persists v1 or reuses previous-process data", async () => {
  assert.ok(integrationProjectId);
  const expected = buildState(
    integrationProjectId,
    1,
    "ds_w57_integration_v1"
  );
  const existing = await getDesiredStateByVersion(integrationProjectId, 1);
  created = existing ?? (await createDesiredState(expected));

  assert.equal(created.desiredStateId, expected.desiredStateId);
  assert.equal(created.projectId, integrationProjectId);
  assert.equal(created.version, 1);
  assert.deepEqual(created.applications, expected.applications);
  assert.deepEqual(created.runtime, expected.runtime);
  assert.deepEqual(created.resources, expected.resources);
  assert.deepEqual(created.environment, expected.environment);
  assert.deepEqual(created.deployment, expected.deployment);
  assert.deepEqual(created.health, expected.health);
  assert.ok(created.createdAt instanceof Date);
  assert.ok(created.updatedAt instanceof Date);
});

test("getCurrentDesiredState returns the highest version", async () => {
  assert.ok(integrationProjectId);
  const history = await listDesiredStateVersions(integrationProjectId);
  assert.ok(history.length >= 1);
  const expectedVersion = Math.max(
    ...history.map((state) => state.version)
  );
  const expected = history.find((state) => state.version === expectedVersion);
  assert.ok(expected);

  const current = await getCurrentDesiredState(integrationProjectId);
  assert.ok(current);
  assert.equal(current.version, expectedVersion);
  assert.deepEqual(current.applications, expected.applications);
  assert.deepEqual(current.environment, expected.environment);
  assert.deepEqual(current.deployment, expected.deployment);
  assert.deepEqual(current.health, expected.health);
  assert.ok(current.createdAt instanceof Date);
  assert.ok(current.updatedAt instanceof Date);
});

test("appends v2 and preserves version history", async () => {
  assert.ok(integrationProjectId);
  const existingV2 = await getDesiredStateByVersion(integrationProjectId, 2);
  if (!existingV2) {
    await createDesiredState(
      buildState(integrationProjectId, 2, "ds_w57_integration_v2")
    );
  }

  const history = await listDesiredStateVersions(integrationProjectId);
  assert.deepEqual(
    history.map((state) => state.version),
    [1, 2]
  );

  const current = await getCurrentDesiredState(integrationProjectId);
  assert.equal(current?.version, 2);

  const v1 = await getDesiredStateByVersion(integrationProjectId, 1);
  assert.equal(v1?.version, 1);
});

test("desired states are isolated per project", async () => {
  assert.ok(isolationProjectId);
  assert.ok(integrationProjectId);
  const existing = await getCurrentDesiredState(isolationProjectId);
  if (!existing) {
    await createDesiredState(
      buildState(isolationProjectId, 1, "ds_w57_isolation_v1")
    );
  }

  const integrationHistory =
    await listDesiredStateVersions(integrationProjectId);
  const isolationHistory = await listDesiredStateVersions(isolationProjectId);
  assert.deepEqual(
    isolationHistory.map((state) => state.version),
    [1]
  );
  assert.ok(
    integrationHistory.every((state) => state.projectId === integrationProjectId)
  );

  const isolated = await getCurrentDesiredState(isolationProjectId);
  assert.equal(isolated?.desiredStateId, "ds_w57_isolation_v1");
  assert.equal(isolated?.projectId, isolationProjectId);
});

test("duplicate version raises DuplicateVersionError", async () => {
  assert.ok(integrationProjectId);
  const duplicate = buildState(
    integrationProjectId,
    1,
    "ds_w57_duplicate_v1"
  );
  await assert.rejects(createDesiredState(duplicate), (error: unknown) => {
    assert.ok(error instanceof DuplicateVersionError);
    assert.equal((error as DuplicateVersionError).code, "DUPLICATE_VERSION");
    return true;
  });
});

test("unknown project raises InvalidProjectError", async () => {
  const orphan = buildState("prj_w57_does_not_exist", 1, "ds_orphan");
  await assert.rejects(createDesiredState(orphan), (error: unknown) => {
    assert.ok(error instanceof InvalidProjectError);
    assert.equal((error as InvalidProjectError).code, "INVALID_PROJECT");
    return true;
  });
});

test("missing desired states resolve to null", async () => {
  assert.ok(isolationProjectId);
  assert.equal(await getDesiredStateByVersion(isolationProjectId, 999), null);
  assert.equal(await getCurrentDesiredState("prj_w57_does_not_exist"), null);
  assert.equal(
    await getDesiredStateByVersion("prj_w57_does_not_exist", 1),
    null
  );
});

test("rows are stored in the DesiredState table with JSON payload", async () => {
  assert.ok(integrationProjectId);
  const row = await prisma.desiredState.findUnique({
    where: {
      projectId_version: { projectId: integrationProjectId, version: 2 },
    },
  });
  assert.ok(row);
  assert.equal(row.version, 2);
  const data = row.data as { applications?: { image?: string } };
  assert.equal(data.applications?.image, "forge-api:v2");
});