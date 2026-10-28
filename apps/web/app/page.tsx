import { connection } from "next/server";
import ProjectDashboard from "../components/ProjectDashboard";
import { Project } from "../types/project";

export default async function Home() {
  // The dashboard reads live project data, so rendering must wait for the
  // incoming request instead of running during build-time prerendering.
  await connection();

  const response = await fetch("http://localhost:3000/api/projects", {
    cache: "no-store",
  });

  const result = await response.json();

  const projects: Project[] = result.data;

  return (
    <main>
      <h1>Control Platform</h1>

      <p>
        Manage your applications and infrastructure.
      </p>

      <ProjectDashboard initialProjects={projects} />
    </main>
  );
}