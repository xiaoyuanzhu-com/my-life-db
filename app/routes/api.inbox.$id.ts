import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getFileByPath, upsertFileRecord, deleteFileRecord, deleteFilesByPrefix } from "~/.server/db/files";
import { deleteDigestsForPath, deleteDigestsByPrefix } from "~/.server/db/digests";
import { getStorageConfig } from "~/.server/config/storage";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getDigestStatusView } from "~/.server/inbox/status-view";
import { getLogger } from "~/.server/log/logger";
import {
  readPrimaryText,
  readDigestSummary,
  readDigestTags,
  readDigestScreenshot,
} from "~/.server/inbox/digest-artifacts";

const log = getLogger({ module: "ApiInboxById" });

export async function loader({ params }: LoaderFunctionArgs) {
  try {
    const { id } = params;
    const filePath = `inbox/${id}`;
    const file = getFileByPath(filePath);

    if (!file) {
      return Response.json({ error: "Inbox item not found" }, { status: 404 });
    }

    const enrichment = getDigestStatusView(filePath);
    const [primaryText, summary, tags, screenshot] = await Promise.all([
      readPrimaryText(filePath),
      readDigestSummary(filePath),
      readDigestTags(filePath),
      readDigestScreenshot(filePath),
    ]);

    return Response.json({
      path: file.path,
      name: file.name,
      isFolder: file.isFolder,
      files: [],
      createdAt: file.createdAt,
      updatedAt: file.modifiedAt,
      enrichment,
      primaryText,
      digest: { summary, tags, screenshot },
    });
  } catch (error) {
    log.error({ err: error }, "fetch inbox item failed");
    return Response.json({ error: "Failed to fetch inbox item" }, { status: 500 });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { id } = params;
  const filePath = `inbox/${id}`;

  if (request.method === "PUT") {
    try {
      if (!filePath.endsWith(".md")) {
        return Response.json({ error: "Only markdown files can be edited" }, { status: 400 });
      }

      const file = getFileByPath(filePath);
      if (!file) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }

      const config = await getStorageConfig();
      const body = await request.json();
      const text = body.text;

      if (typeof text !== "string") {
        return Response.json({ error: "Text content required" }, { status: 400 });
      }

      const fullPath = path.join(config.dataPath, filePath);
      await fs.writeFile(fullPath, text, "utf-8");

      const stats = await fs.stat(fullPath);
      const hash =
        text.length < 10 * 1024 * 1024
          ? crypto.createHash("sha256").update(text).digest("hex")
          : undefined;

      const lines = text.split("\n").slice(0, 50);
      const textPreview = lines.join("\n");

      upsertFileRecord({
        path: filePath,
        name: file.name,
        isFolder: false,
        mimeType: "text/markdown",
        size: stats.size,
        hash,
        modifiedAt: stats.mtime.toISOString(),
        textPreview,
      });

      const updatedFile = getFileByPath(filePath);
      return Response.json(updatedFile);
    } catch (error) {
      log.error({ err: error }, "update inbox item failed");
      return Response.json({ error: "Failed to update inbox item" }, { status: 500 });
    }
  }

  if (request.method === "DELETE") {
    try {
      const file = getFileByPath(filePath);
      if (!file) {
        return Response.json({ error: "Inbox item not found" }, { status: 404 });
      }

      const config = await getStorageConfig();
      const fullPath = path.join(config.dataPath, filePath);

      await fs.rm(fullPath, { recursive: true, force: true });

      if (file.isFolder) {
        deleteFilesByPrefix(`${filePath}/`);
        deleteDigestsByPrefix(`${filePath}/`);
      }
      deleteFileRecord(filePath);
      deleteDigestsForPath(filePath);

      log.info({ path: filePath }, "deleted inbox item");
      return Response.json({ success: true });
    } catch (error) {
      log.error({ err: error }, "delete inbox item failed");
      return Response.json({ error: "Failed to delete inbox item" }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
