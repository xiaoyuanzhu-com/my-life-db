import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { getFileByPath } from "~/lib/db/files";
import { getDigestStatusView } from "~/lib/inbox/status-view";
import { processFileDigests } from "~/lib/digest/task-handler";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiDigest" });

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export async function loader({ params, request }: LoaderFunctionArgs) {
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
    const url = new URL(request.url);
    const digester = url.searchParams.get("digester");

    if (!filePath) {
      return Response.json({ error: "Missing file path" }, { status: 400 });
    }

    const file = getFileByPath(filePath);
    if (!file) {
      return Response.json({ error: "File not found" }, { status: 404 });
    }

    await processFileDigests(filePath, {
      reset: true,
      digester: digester || undefined,
    });

    return Response.json({
      success: true,
      message: digester
        ? `Digest "${digester}" processing complete.`
        : "Digest processing complete.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof Error && error.message.includes("No digest workflow available")
        ? 400
        : 500;

    log.error({ err: error, filePath }, "failed to enqueue digest workflow");
    return Response.json({ error: errorMessage }, { status: statusCode });
  }
}
