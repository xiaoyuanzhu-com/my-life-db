import type { LoaderFunctionArgs } from "react-router";
import { getFileByPath } from "~/.server/db/files";
import { listDigestsForPath } from "~/.server/db/digests";
import { DIGESTER_ORDER } from "~/.server/digest/constants";

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const decodePathParam = (value: string): string => {
  const once = safeDecodeURIComponent(value);
  return /%[0-9A-Fa-f]{2}/.test(once) ? safeDecodeURIComponent(once) : once;
};

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const rawPath = url.searchParams.get("path");
    const filePath = rawPath ? decodePathParam(rawPath) : null;

    if (!filePath) {
      return Response.json({ error: "Missing path parameter" }, { status: 400 });
    }

    const fileRecord = getFileByPath(filePath);
    if (!fileRecord) {
      return Response.json({ error: "File not found in database" }, { status: 404 });
    }

    const digests = listDigestsForPath(filePath, {
      order: "asc",
      excludeStatuses: ["skipped"],
      excludeDigesters: ["url-crawl"],
    });

    // Sort digests by backend processing order
    const orderMap = new Map(DIGESTER_ORDER.map((d, i) => [d, i]));
    const sortedDigests = [...digests].sort((a, b) => {
      const orderA = orderMap.get(a.digester) ?? Infinity;
      const orderB = orderMap.get(b.digester) ?? Infinity;
      return orderA - orderB;
    });

    return Response.json({ file: fileRecord, digests: sortedDigests });
  } catch (error) {
    console.error("Error fetching file info:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
