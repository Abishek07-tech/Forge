export interface DesiredState {
  desiredStateId: string;
  projectId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  applications: Application;
  runtime: Runtime;
  resources: Resources;
  environment?: Environment;
  deployment?: Deployment;
  health: Health;
}

export interface Application {
  image: string;
  version?: string;
  port: number;
  protocol?: string;
}

export interface Runtime {
  replicas: number;
}

export interface Resources {
  cpu: string;
  memory: string;
}

export type Environment = Record<string, string>;

export interface Deployment {
  version: number;
}

export interface Health {
  path: string;
  port?: number;
}