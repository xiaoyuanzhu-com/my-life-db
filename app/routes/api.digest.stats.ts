import type { LoaderFunctionArgs } from "react-router";
import { getDigestStats } from "~/lib/db/digests";

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const stats = getDigestStats();
    return Response.json(stats);
  } catch (error) {
    console.error("Failed to get digest stats:", error);
    return Response.json({ error: "Failed to get digest stats" }, { status: 500 });
  }
}
