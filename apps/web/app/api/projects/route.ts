import { projects } from "../../../data/projects";

export async function GET() {
  return Response.json({
    success: true,
    data: projects,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (
      !body.name ||
      typeof body.name !== "string" ||
      !body.name.trim()
    ) {
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

    const projectName = body.name.trim();

    const newProject = {
      id: `p${projects.length + 1}`,
      name: projectName,
      status: "stopped" as const,
      deployments: 0,
    };

    projects.push(newProject);

    return Response.json(
      {
        success: true,
        data: newProject,
      },
      {
        status: 201,
      }
    );
  } catch {
    return Response.json(
      {
        success: false,
        error: "Invalid request body",
      },
      {
        status: 400,
      }
    );
  }
}