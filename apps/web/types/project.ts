export interface Project {
  id: string;
  name: string;
  status: "running" | "stopped" | "failed" | "deploying";
  deployments: number;
}