-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('running', 'stopped', 'failed', 'deploying');

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL,
    "deployments" INTEGER NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);
