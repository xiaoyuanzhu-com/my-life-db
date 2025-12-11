import type { ActionFunctionArgs } from "react-router";
import { getFileByPath } from "~/.server/db/files";
import { initializeDigesters } from "~/.server/digest/initialization";
import { processFileDigests } from "~/.server/digest/task-handler";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiInboxReenrich" });

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure digesters are registered
  initializeDigesters();

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

    log.info({ filePath }, "reenriching inbox item");
    await processFileDigests(filePath, { reset: true });

    return Response.json({
      success: true,
      message: "Digest processing complete. All applicable digesters have run.",
    });
  } catch (error) {
    log.error({ err: error }, "reenrich inbox item failed");
    return Response.json({ error: "Failed to reenrich inbox item" }, { status: 500 });
  }
}
