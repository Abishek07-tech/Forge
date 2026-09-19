import ProjectCard from "../components/ProjectCard";
import { Project } from "../types/project";

export default async function Home() {
  const response = await fetch("http://localhost:3000/api/projects");

  const projects: Project[] = await response.json();

  return (
    <main>
      <h1>Control Platform</h1>

      <p>
        Manage your applications and infrastructure.
      </p>

      <section>
        <h2>Overview</h2>

        <p>Projects: {projects.length}</p>

        <p>
          Running:{" "}
          {projects.filter((project) => project.status === "running").length}
        </p>
      </section>

      <section>
        <h2>Projects</h2>

        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
          />
        ))}
      </section>
    </main>
  );
}