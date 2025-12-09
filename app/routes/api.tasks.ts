import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getTasks, createTask, getTaskStats } from "~/lib/task-queue/task-manager";
import type { TaskStatus } from "~/lib/task-queue/types";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiTasks" });

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") as TaskStatus | null;
    const type = url.searchParams.get("type");
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    const includeStats = url.searchParams.get("stats") === "true";

    const filters: Parameters<typeof getTasks>[0] = { limit, offset };
    if (status) filters.status = status;
    if (type) filters.type = type;

    const tasks = getTasks(filters);

    const response: {
      tasks: typeof tasks;
      total: number;
      limit: number;
      offset: number;
      stats?: ReturnType<typeof getTaskStats>;
    } = { tasks, total: tasks.length, limit, offset };

    if (includeStats) {
      response.stats = getTaskStats();
    }

    return Response.json(response);
  } catch (error) {
    log.error({ err: error }, "get tasks failed");
    return Response.json({ error: "Failed to fetch tasks" }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { type, input, run_after } = body;

    if (!type || typeof type !== "string") {
      return Response.json({ error: "Task type is required" }, { status: 400 });
    }
    if (!input || typeof input !== "object") {
      return Response.json({ error: "Task input is required" }, { status: 400 });
    }

    const task = createTask({ type, input, run_after });
    return Response.json(task, { status: 201 });
  } catch (error) {
    log.error({ err: error }, "create task failed");
    return Response.json({ error: "Failed to create task" }, { status: 500 });
  }
}
