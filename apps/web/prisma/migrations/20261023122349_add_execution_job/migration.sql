-- CreateEnum
CREATE TYPE "ExecutionJobStatus" AS ENUM ('pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ExecutionJobType" AS ENUM ('reconcile', 'deploy', 'scale', 'update', 'retire');

-- CreateTable
CREATE TABLE "ExecutionJob" (
    "jobId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workloadId" TEXT NOT NULL,
    "desiredStateId" TEXT NOT NULL,
    "desiredStateVersion" INTEGER NOT NULL,
    "jobType" "ExecutionJobType" NOT NULL,
    "status" "ExecutionJobStatus" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "correlationId" TEXT,
    "failure" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "queuedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ExecutionJob_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX "ExecutionJob_projectId_status_idx" ON "ExecutionJob"("projectId", "status");

-- CreateIndex
CREATE INDEX "ExecutionJob_projectId_workloadId_updatedAt_idx" ON "ExecutionJob"("projectId", "workloadId", "updatedAt");

-- CreateIndex
CREATE INDEX "ExecutionJob_projectId_workloadId_desiredStateId_status_idx" ON "ExecutionJob"("projectId", "workloadId", "desiredStateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionJob_idempotencyKey_key" ON "ExecutionJob"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExecutionJob" ADD CONSTRAINT "ExecutionJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
