import { projects } from "../../../data/projects";

export async function GET() {
  return Response.json({
    success: true,
    data: projects,
  });
}

export async function POST(request: Request) {
  const body = await request.json();

  if (!body.name) {
    return Response.json(
      {
        success: false,
        error: "Project name is required",
      },
      {
        status: 400,
      }
    );
  }

  const newProject = {
    id: `p${projects.length + 1}`,
    name: body.name,
    status: "stopped" as const,
    deployments: 0,
  };

  projects.push(newProject);

  return Response.json({
    success: true,
    data: newProject,
  });
}