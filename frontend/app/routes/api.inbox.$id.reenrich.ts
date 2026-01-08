import type { ActionFunctionArgs } from "react-router";
import { getFileByPath } from "~/.server/db/files";
import { requestDigest } from "~/.server/workers/digest/client";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiInboxReenrich" });

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { id } = params;
    const filePath = `inbox/${id}`;

    const file = getFileByPath(filePath);
    if (!file) {
      return Response.json({ error: "Inbox item not found" }, { status: 404 });
    }

    log.info({ filePath }, "requesting reenrich for inbox item");
    requestDigest(filePath, true);

    return Response.json({
      success: true,
      message: "Digest processing queued.",
    });
  } catch (error) {
    log.error({ err: error }, "reenrich inbox item failed");
    return Response.json({ error: "Failed to reenrich inbox item" }, { status: 500 });
  }
}
