import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getFileByPath } from "~/.server/db/files";
import { getDigestStatusView } from "~/.server/inbox/status-view";
import { requestDigest } from "~/.server/workers/digest/client";
import { getLogger } from "~/.server/log/logger";

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const log = getLogger({ module: "ApiDigest" });

export async function loader({ params }: LoaderFunctionArgs) {
  try {
    const splat = params["*"] || "";
    const filePath = splat.split("/").map(safeDecodeURIComponent).join("/");

    if (!filePath) {
      return Response.json({ error: "Missing file path" }, { status: 400 });
    }

    const file = getFileByPath(filePath);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    const status = getDigestStatusView(filePath);
    return Response.json({ status });
  } catch (error) {
    log.error({ err: error }, "failed to fetch digest status");
    return Response.json({ error: "Failed to fetch digest status" }, { status: 500 });
  }
}

export async function action({ params, request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let filePath: string | null = null;
  try {
    const splat = params["*"] || "";
    filePath = splat.split("/").map(safeDecodeURIComponent).join("/");

    if (!filePath) {
      return Response.json({ error: "Missing file path" }, { status: 400 });
    }

    const file = getFileByPath(filePath);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    // Check for specific digester parameter
    const url = new URL(request.url);
    const digester = url.searchParams.get("digester") || undefined;

    // Queue digest processing via worker
    requestDigest(filePath, true, digester);

    return Response.json({
      success: true,
      message: digester
        ? `Digest "${digester}" processing queued.`
        : "Digest processing queued.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ err: error, filePath }, "failed to queue digest processing");
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
