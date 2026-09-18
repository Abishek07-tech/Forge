import { projects } from "../../../data/projects";

export async function GET() {
  return Response.json(projects);
}