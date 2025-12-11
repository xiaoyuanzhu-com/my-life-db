import type { LoaderFunctionArgs } from "react-router";
import { getFilePosition } from "~/.server/db/files";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiInboxPosition" });
const BATCH_SIZE = 30;

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");

    if (!path) {
      return Response.json({ error: "Path is required" }, { status: 400 });
    }

    const result = getFilePosition(path, "inbox/", "created_at", false);

    if (!result) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    const batchOffset = Math.floor(result.position / BATCH_SIZE) * BATCH_SIZE;

    return Response.json({
      path,
      position: result.position,
      total: result.total,
      batchOffset,
      batchSize: BATCH_SIZE,
    });
  } catch (error) {
    log.error({ err: error }, "get position failed");
    return Response.json({ error: "Failed to get position" }, { status: 500 });
  }
}
