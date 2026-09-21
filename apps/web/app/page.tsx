import ProjectDashboard from "../components/ProjectDashboard";
import { Project } from "../types/project";

export default async function Home() {
  const response = await fetch("http://localhost:3000/api/projects");

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