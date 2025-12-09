import type { ActionFunctionArgs } from "react-router";
import { getFileByPath } from "~/lib/db/files";
import { deleteFile } from "~/lib/files/delete-file";
import { notificationService } from "~/lib/notifications/notification-service";
import { getStorageConfig } from "~/lib/config/storage";
import path from "path";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiLibraryFile" });

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path");

    if (!filePath) {
      return Response.json({ error: "Missing path parameter" }, { status: 400 });
    }

    const topLevelFolder = filePath.split("/")[0];
    if (topLevelFolder === "app") {
      return Response.json({ error: "Cannot delete app folder" }, { status: 403 });
    }

    const file = getFileByPath(filePath);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    const config = await getStorageConfig();
    const fullPath = path.join(config.dataPath, filePath);

    const result = await deleteFile({
      fullPath,
      relativePath: filePath,
      isFolder: file.isFolder,
    });

    if (!result.success) {
      throw new Error("Delete operation failed");
    }

    log.info(
      { filePath, isFolder: file.isFolder, ...result.databaseRecordsDeleted },
      "file deleted successfully"
    );

    if (filePath.startsWith("inbox/")) {
      notificationService.notify({
        type: "inbox-deleted",
        path: filePath,
        timestamp: new Date().toISOString(),
        metadata: { name: file.name },
      });
    }

    return Response.json({ success: true, result });
  } catch (error) {
    log.error({ err: error }, "delete file failed");
    return Response.json({ error: "Failed to delete file" }, { status: 500 });
  }
}
