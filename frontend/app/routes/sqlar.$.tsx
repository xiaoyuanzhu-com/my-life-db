import type { LoaderFunctionArgs } from "react-router";
import { sqlarGet } from "~/.server/db/sqlar";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "SqlarAPI" });

function getContentType(extension: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    html: "text/html",
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    pdf: "application/pdf",
  };
  return map[extension] || "application/octet-stream";
}

/**
 * GET /sqlar/*
 * Serve files from SQLAR storage
 * Example: /sqlar/{path-hash}/{digest-type}/filename.ext
 */
export async function loader({ params }: LoaderFunctionArgs) {
  try {
    const pathParam = params["*"] || "";
    const sqlarName = pathParam;

    log.debug({ sqlarName }, "fetching file from sqlar");

    const data = await sqlarGet(sqlarName);

    if (!data) {
      log.warn({ sqlarName }, "file not found in sqlar");
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    // Determine content type from file extension
    const extension = sqlarName.split(".").pop()?.toLowerCase() || "";
    const contentType = getContentType(extension);

    return new Response(data as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    log.error({ err: error }, "failed to serve sqlar file");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
