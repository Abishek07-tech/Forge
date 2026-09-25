-- CreateTable
CREATE TABLE "DesiredState" (
    "desiredStateId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "DesiredState_pkey" PRIMARY KEY ("desiredStateId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesiredState_projectId_version_key" ON "DesiredState"("projectId", "version");

-- AddForeignKey
ALTER TABLE "DesiredState" ADD CONSTRAINT "DesiredState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
