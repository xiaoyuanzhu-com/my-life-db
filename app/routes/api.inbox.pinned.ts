import type { LoaderFunctionArgs } from "react-router";
import { listPinnedFiles } from "~/lib/db/pins";
import { getFileByPath } from "~/lib/db/files";
import type { PinnedItem } from "~/types/pin";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiInboxPinned" });

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const pins = listPinnedFiles("inbox/");

    const items: PinnedItem[] = pins.map((pin) => {
      const file = getFileByPath(pin.filePath);
      return {
        path: pin.filePath,
        name: file?.name ?? pin.filePath.split("/").pop() ?? "",
        pinnedAt: pin.pinnedAt,
        displayText: pin.displayText ?? file?.name ?? "",
      };
    });

    return Response.json({ items });
  } catch (error) {
    log.error({ err: error }, "list pinned items failed");
    return Response.json({ error: "Failed to list pinned items" }, { status: 500 });
  }
}
