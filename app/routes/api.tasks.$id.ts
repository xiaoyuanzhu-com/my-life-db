import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getTaskById, deleteTask } from "~/lib/task-queue/task-manager";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiTaskById" });

export async function loader({ params }: LoaderFunctionArgs) {
  try {
    const { id } = params;
    const task = getTaskById(id!);

    if (!task) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    return Response.json(task);
  } catch (error) {
    log.error({ err: error }, "get task failed");
    return Response.json({ error: "Failed to fetch task" }, { status: 500 });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { id } = params;
    const deleted = deleteTask(id!);

    if (!deleted) {
      return Response.json({ error: "Task not found" }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (error) {
    log.error({ err: error }, "delete task failed");
    return Response.json({ error: "Failed to delete task" }, { status: 500 });
  }
}
