import type { ActionFunctionArgs } from "react-router";
import { pauseWorker, getWorker } from "~/.server/task-queue/worker";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiWorkerPause" });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    pauseWorker();
    const worker = getWorker();

    return Response.json({
      success: true,
      status: { running: worker.isRunning(), paused: worker.isPaused() },
    });
  } catch (error) {
    log.error({ err: error }, "pause worker failed");
    return Response.json({ error: "Failed to pause worker" }, { status: 500 });
  }
}
