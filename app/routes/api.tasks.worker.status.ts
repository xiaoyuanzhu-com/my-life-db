import type { LoaderFunctionArgs } from "react-router";
import { getWorker } from "~/lib/task-queue/worker";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiWorkerStatus" });

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const worker = getWorker();

    return Response.json({
      running: worker.isRunning(),
      paused: worker.isPaused(),
    });
  } catch (error) {
    log.error({ err: error }, "get worker status failed");
    return Response.json({ error: "Failed to fetch worker status" }, { status: 500 });
  }
}
