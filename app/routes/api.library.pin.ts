import type { ActionFunctionArgs } from "react-router";
import { togglePinFile } from "~/lib/db/pins";
import { notificationService } from "~/lib/notifications/notification-service";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiPin" });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { path } = await request.json();

    if (!path || typeof path !== "string") {
      return Response.json({ error: "Path is required" }, { status: 400 });
    }

    const isPinned = togglePinFile(path);
    log.info({ path, isPinned }, "toggled pin state");

    notificationService.notify({
      type: "pin-changed",
      path,
      timestamp: new Date().toISOString(),
    });

    return Response.json({ isPinned });
  } catch (error) {
    log.error({ err: error }, "toggle pin failed");
    return Response.json({ error: "Failed to toggle pin" }, { status: 500 });
  }
}
