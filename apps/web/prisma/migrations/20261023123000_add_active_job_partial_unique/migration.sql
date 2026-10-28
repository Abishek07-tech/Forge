-- At most one active (pending/queued/running) execution job may exist for a
-- given resource and Desired State intent. Terminal jobs are unrestricted so
-- history is preserved.
CREATE UNIQUE INDEX "ExecutionJob_projectId_workloadId_desiredStateId_active_key"
ON "ExecutionJob"("projectId", "workloadId", "desiredStateId")
WHERE "status" IN ('pending', 'queued', 'running');
