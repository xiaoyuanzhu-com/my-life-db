import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import type { FileWithDigests } from "~/types/file-card";
import { listTopLevelFiles, countTopLevelFiles } from "~/.server/db/files";
import { isPinned } from "~/.server/db/pins";
import { saveToInbox } from "~/.server/inbox/save-to-inbox";
import { initializeDigesters } from "~/.server/digest/initialization";
import { processFileDigests } from "~/.server/digest/task-handler";
import { getLogger } from "~/.server/log/logger";
import { notificationService } from "~/.server/notifications/notification-service";

const log = getLogger({ module: "ApiInbox" });

export interface InboxItem extends FileWithDigests {
  textPreview?: string;
}

export interface InboxResponse {
  items: InboxItem[];
  total: number;
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const limit = url.searchParams.get("limit")
      ? parseInt(url.searchParams.get("limit")!)
      : 50;
    const offset = url.searchParams.get("offset")
      ? parseInt(url.searchParams.get("offset")!)
      : 0;

    const files = listTopLevelFiles("inbox/", {
      orderBy: "created_at",
      ascending: false,
      limit,
      offset,
    });

    const total = countTopLevelFiles("inbox/");

    // Convert FileRecord to InboxItem
    // Uses cached fields: textPreview, screenshotSqlar (no digest queries needed!)
    const items: InboxItem[] = files.map((file) => ({
      path: file.path,
      name: file.name,
      isFolder: file.isFolder,
      size: file.size,
      mimeType: file.mimeType,
      hash: file.hash,
      modifiedAt: file.modifiedAt,
      createdAt: file.createdAt,
      digests: [],  // Not needed - screenshotSqlar is cached on FileRecord
      textPreview: file.textPreview || undefined,
      screenshotSqlar: file.screenshotSqlar || undefined,
      isPinned: isPinned(file.path),
    }));

    const response: InboxResponse = { items, total };
    return Response.json(response);
  } catch (error) {
    log.error({ err: error }, "list inbox items failed");
    return Response.json({ error: "Failed to list inbox items" }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  // Ensure digesters are registered
  initializeDigesters();

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const formData = await request.formData();
    const text = formData.get("text") as string | null;
    const fileEntries = formData.getAll("files") as File[];

    if (!text && fileEntries.length === 0) {
      return Response.json(
        { error: "Either text or files must be provided" },
        { status: 400 }
      );
    }

    const files = [];
    for (const file of fileEntries) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      files.push({
        buffer,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      });
    }

    const result = await saveToInbox({
      text: text || undefined,
      files,
    });

    log.info({ paths: result.paths, fileCount: result.files.length }, "created inbox items");

    for (let i = 0; i < result.paths.length; i++) {
      const filePath = result.paths[i];
      const file = result.files[i];
      notificationService.notify({
        type: "inbox-created",
        path: filePath,
        timestamp: new Date().toISOString(),
        metadata: file
          ? {
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
            }
          : undefined,
      });
    }

    for (const filePath of result.paths) {
      processFileDigests(filePath).catch((error) => {
        log.error({ path: filePath, error }, "digest processing failed");
      });
    }
    log.info({ paths: result.paths }, "auto-started digest processing for all files");

    return Response.json(
      { path: result.path, paths: result.paths },
      { status: 201 }
    );
  } catch (error) {
    log.error({ err: error }, "create inbox item failed");
    return Response.json(
      {
        error: "Failed to create inbox item",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
