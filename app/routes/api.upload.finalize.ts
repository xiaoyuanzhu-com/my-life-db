import type { ActionFunctionArgs } from "react-router";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { saveToInbox } from "~/.server/inbox/save-to-inbox";
import { requestDigest } from "~/.server/workers/digest-client";

const DATA_ROOT = process.env.MY_DATA_DIR || path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_ROOT, "app", "my-life-db", "uploads");

interface FinalizeRequest {
  uploads: Array<{
    uploadId: string;
    filename: string;
    size: number;
    type: string;
  }>;
  text?: string;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body: FinalizeRequest = await request.json();
    const { uploads, text } = body;

    if (!uploads || uploads.length === 0) {
      return Response.json({ error: "No uploads provided" }, { status: 400 });
    }

    const files: Array<{
      filename: string;
      buffer: Buffer;
      mimeType: string;
      size: number;
    }> = [];

    for (const upload of uploads) {
      const tusFilePath = path.join(UPLOAD_DIR, upload.uploadId);
      const metadataPath = `${tusFilePath}.json`;

      if (!existsSync(tusFilePath)) {
        console.error(`[FINALIZE] Upload file not found: ${tusFilePath}`);
        continue;
      }

      const buffer = await fs.readFile(tusFilePath);
      files.push({
        filename: upload.filename,
        buffer,
        mimeType: upload.type,
        size: upload.size,
      });

      try {
        await fs.unlink(tusFilePath);
        if (existsSync(metadataPath)) {
          await fs.unlink(metadataPath);
        }
      } catch (err) {
        console.error("[FINALIZE] Error cleaning up tus files:", err);
      }
    }

    if (files.length === 0 && !text) {
      return Response.json({ error: "No valid files or text to save" }, { status: 400 });
    }

    const result = await saveToInbox({
      text: text || undefined,
      files: files.length > 0 ? files : undefined,
    });

    // Trigger digest processing via worker
    for (const filePath of result.paths) {
      requestDigest(filePath);
    }

    return Response.json(
      { success: true, path: result.path, paths: result.paths },
      { status: 201 }
    );
  } catch (error) {
    console.error("[FINALIZE] Error finalizing upload:", error);
    return Response.json({ error: "Failed to finalize upload" }, { status: 500 });
  }
}
