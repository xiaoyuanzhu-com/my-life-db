import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import type { FileWithDigests } from "~/types/file-card";
import {
  listTopLevelFilesNewest,
  listTopLevelFilesBefore,
  listTopLevelFilesAfter,
  listTopLevelFilesAround,
  parseCursor,
  createCursor,
} from "~/.server/db/files";
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
  cursors: {
    first: string | null;
    last: string | null;
  };
  hasMore: {
    older: boolean;
    newer: boolean;
  };
}

const DEFAULT_LIMIT = 30;

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const limit = url.searchParams.get("limit")
      ? parseInt(url.searchParams.get("limit")!)
      : DEFAULT_LIMIT;
    const before = url.searchParams.get("before");
    const after = url.searchParams.get("after");
    const around = url.searchParams.get("around");

    let result;

    if (around) {
      // Load page containing specific cursor (for pin navigation)
      const cursor = parseCursor(around);
      if (!cursor) {
        return Response.json({ error: "Invalid around cursor format" }, { status: 400 });
      }
      const aroundResult = listTopLevelFilesAround("inbox/", cursor, limit);
      result = {
        items: aroundResult.items,
        cursors: aroundResult.cursors,
        hasMore: aroundResult.hasMore,
        targetIndex: aroundResult.targetIndex,
      };
    } else if (before) {
      // Load older items
      const cursor = parseCursor(before);
      if (!cursor) {
        return Response.json({ error: "Invalid before cursor format" }, { status: 400 });
      }
      result = listTopLevelFilesBefore("inbox/", cursor, limit);
    } else if (after) {
      // Load newer items
      const cursor = parseCursor(after);
      if (!cursor) {
        return Response.json({ error: "Invalid after cursor format" }, { status: 400 });
      }
      result = listTopLevelFilesAfter("inbox/", cursor, limit);
    } else {
      // Load newest page (initial load)
      result = listTopLevelFilesNewest("inbox/", limit);
    }

    // Convert FileRecord to InboxItem
    // Uses cached fields: textPreview, screenshotSqlar (no digest queries needed!)
    const items: InboxItem[] = result.items.map((file) => ({
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

    // Build response with proper cursors from the mapped items
    const response: InboxResponse & { targetIndex?: number } = {
      items,
      cursors: {
        first: items.length > 0 ? createCursor(items[0]) : null,
        last: items.length > 0 ? createCursor(items[items.length - 1]) : null,
      },
      hasMore: result.hasMore,
    };

    // Include targetIndex for around queries
    if ('targetIndex' in result) {
      response.targetIndex = result.targetIndex;
    }

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

    // Notify UI of inbox change (single notification for all files)
    if (result.paths.length > 0) {
      notificationService.notify({
        type: "inbox-changed",
        timestamp: new Date().toISOString(),
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
