import { prisma } from "../../../lib/prisma";

export async function GET() {
  try {
    const projects = await prisma.project.findMany({
      orderBy: { name: "asc" },
    });

    return Response.json({
      success: true,
      data: projects,
    });
  } catch {
    return Response.json(
      {
        success: false,
        error: "Failed to fetch projects",
      },
      {
        status: 500,
      }
    );
  }
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

    try {
      const newProject = await prisma.project.create({
        data: {
          name: projectName,
          status: "stopped",
          deployments: 0,
        },
      });

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
          error: "Failed to create project",
        },
        {
          status: 500,
        }
      );
    }
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