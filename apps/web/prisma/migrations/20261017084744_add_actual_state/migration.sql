-- CreateEnum
CREATE TYPE "ObservedStatus" AS ENUM ('running', 'stopped', 'failed', 'unknown');

-- CreateTable
CREATE TABLE "ActualStateObservation" (
    "observationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workloadId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "status" "ObservedStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "data" JSONB NOT NULL,

    CONSTRAINT "ActualStateObservation_pkey" PRIMARY KEY ("observationId")
);

-- CreateIndex
CREATE INDEX "ActualStateObservation_projectId_workloadId_observedAt_idx" ON "ActualStateObservation"("projectId", "workloadId", "observedAt");

-- AddForeignKey
ALTER TABLE "ActualStateObservation" ADD CONSTRAINT "ActualStateObservation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
