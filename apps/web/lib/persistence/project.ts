import { prisma } from "../prisma.ts";

// Minimal project-existence read for services that must distinguish an
// unknown project from a project without desired state.
export async function projectExists(projectId: string): Promise<boolean> {
  const row = await prisma.project.findUnique({ where: { id: projectId } });
  return row !== null;
}
