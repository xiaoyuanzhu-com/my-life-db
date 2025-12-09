import type { LoaderFunctionArgs } from "react-router";
import { getDigestStatusView } from "~/lib/inbox/status-view";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiInboxStatus" });

export async function loader({ params }: LoaderFunctionArgs) {
  try {
    const { id } = params;
    const filePath = `inbox/${id}`;
    const view = getDigestStatusView(filePath);
    if (!view) {
      return Response.json({ error: "Inbox item not found" }, { status: 404 });
    }
    return Response.json(view);
  } catch (error) {
    log.error({ err: error }, "get inbox status failed");
    return Response.json({ error: "Failed to get inbox status" }, { status: 500 });
  }
}
