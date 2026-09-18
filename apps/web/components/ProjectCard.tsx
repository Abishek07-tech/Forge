import { Project } from "../types/project";

interface ProjectCardProps {
  project: Project;
}

export default function ProjectCard({ project }: ProjectCardProps) {
  return (
    <div>
      <h3>{project.name}</h3>

      <p>Deployments: {project.deployments}</p>

      <span>Status: {project.status}</span>
    </div>
  );
}