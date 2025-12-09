import type { ActionFunctionArgs } from "react-router";
import { resumeWorker, getWorker } from "~/lib/task-queue/worker";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiWorkerResume" });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    resumeWorker();
    const worker = getWorker();

    return Response.json({
      success: true,
      status: { running: worker.isRunning(), paused: worker.isPaused() },
    });
  } catch (error) {
    log.error({ err: error }, "resume worker failed");
    return Response.json({ error: "Failed to resume worker" }, { status: 500 });
  }
}
