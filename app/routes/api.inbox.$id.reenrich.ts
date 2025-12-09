import type { ActionFunctionArgs } from "react-router";
import { getFileByPath } from "~/lib/db/files";
import { processFileDigests } from "~/lib/digest/task-handler";
import { getLogger } from "~/lib/log/logger";

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
