import { projects } from "../data/projects";
import ProjectCard from "../components/ProjectCard";

export default function Home() {
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