import type { LoaderFunctionArgs } from "react-router";
import { listPinnedFiles } from "~/.server/db/pins";
import { getFileByPath, createCursor } from "~/.server/db/files";
import type { PinnedItem } from "~/types/pin";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiInboxPinned" });

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const pins = listPinnedFiles("inbox/");

    const items: PinnedItem[] = pins
      .map((pin) => {
        const file = getFileByPath(pin.filePath);
        if (!file) return null;

        return {
          path: pin.filePath,
          name: file.name,
          pinnedAt: pin.pinnedAt,
          displayText: pin.displayText ?? file.name,
          cursor: createCursor(file),
        };
      })
      .filter((item): item is PinnedItem => item !== null);

    return Response.json({ items });
  } catch (error) {
    log.error({ err: error }, "list pinned items failed");
    return Response.json({ error: "Failed to list pinned items" }, { status: 500 });
  }
}
