import type { LoaderFunctionArgs } from "react-router";
import { getTaskStats } from "~/.server/task-queue/task-manager";
import { getPendingTaskCountByType, hasReadyTasks } from "~/.server/task-queue/scheduler";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiTaskStats" });

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const basicStats = getTaskStats();
    const pendingByType = getPendingTaskCountByType();
    const hasReady = hasReadyTasks();

    return Response.json({
      ...basicStats,
      pending_by_type: pendingByType,
      has_ready_tasks: hasReady,
    });
  } catch (error) {
    log.error({ err: error }, "get task stats failed");
    return Response.json({ error: "Failed to fetch task statistics" }, { status: 500 });
  }
}
