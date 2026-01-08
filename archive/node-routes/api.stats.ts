import type { LoaderFunctionArgs } from "react-router";
import { dbSelectOne } from "~/.server/db/client";

export async function loader({ request: _request }: LoaderFunctionArgs) {
  try {
    const libraryFiles = dbSelectOne<{ count: number; totalSize: number }>(
      `SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as totalSize
       FROM files
       WHERE is_folder = 0
       AND path NOT LIKE 'app/%'`
    );

    const inboxItems = dbSelectOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM files
       WHERE is_folder = 0
       AND path LIKE 'inbox/%'`
    );

    const totalFiles = dbSelectOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM files
       WHERE is_folder = 0
       AND path NOT LIKE 'app/%'`
    );

    const digestedFiles = dbSelectOne<{ count: number }>(
      `SELECT COUNT(DISTINCT file_path) as count FROM digests
       WHERE status = 'completed'
       AND file_path NOT LIKE 'app/%'`
    );

    const pendingDigests = dbSelectOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM digests
       WHERE status IN ('todo', 'in-progress')
       AND file_path NOT LIKE 'app/%'`
    );

    return Response.json({
      library: {
        fileCount: libraryFiles?.count ?? 0,
        totalSize: libraryFiles?.totalSize ?? 0,
      },
      inbox: {
        itemCount: inboxItems?.count ?? 0,
      },
      digests: {
        totalFiles: totalFiles?.count ?? 0,
        digestedFiles: digestedFiles?.count ?? 0,
        pendingDigests: pendingDigests?.count ?? 0,
      },
    });
  } catch (error) {
    console.error("Failed to get stats:", error);
    return Response.json({ error: "Failed to get stats" }, { status: 500 });
  }
}
