"use client";

import { useState } from "react";
import { Project } from "../types/project";
import CreateProject from "./CreateProject";
import ProjectCard from "./ProjectCard";

interface ProjectDashboardProps {
  initialProjects: Project[];
}

export default function ProjectDashboard({
  initialProjects,
}: ProjectDashboardProps) {
  const [projects, setProjects] = useState(initialProjects);

  function handleProjectCreated(project: Project) {
    setProjects((currentProjects) => [
      ...currentProjects,
      project,
    ]);
  }

  return (
    <>
      <section>
        <h2>Overview</h2>

        <p>Projects: {projects.length}</p>

        <p>
          Running:{" "}
          {
            projects.filter(
              (project) => project.status === "running"
            ).length
          }
        </p>
      </section>

      <section>
        <h2>Projects</h2>

        <CreateProject
          onProjectCreated={handleProjectCreated}
        />

        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
          />
        ))}
      </section>
    </>
  );
}