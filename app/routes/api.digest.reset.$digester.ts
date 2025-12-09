import type { ActionFunctionArgs } from "react-router";
import { withDatabase } from "~/lib/db/client";
import { getLogger } from "~/lib/log/logger";
import { ensureAllDigestersForExistingFiles } from "~/lib/digest/ensure";
import { deleteAllEmbeddings } from "~/lib/db/people";

const log = getLogger({ module: "api/digest/reset" });

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { digester } = params;

  try {
    if (!digester) {
      return Response.json({ error: "Digester type is required" }, { status: 400 });
    }

    let embeddingsDeleted = 0;
    if (digester === "speaker-embedding") {
      try {
        embeddingsDeleted = deleteAllEmbeddings();
        log.info({ embeddingsDeleted }, "cleared people embeddings");
      } catch (error) {
        log.warn({ error }, "failed to clear people embeddings");
      }
    }

    const deletedCount = withDatabase((db) => {
      const countStmt = db.prepare("SELECT COUNT(*) as count FROM digests WHERE digester = ?");
      const { count } = countStmt.get(digester) as { count: number };

      if (count === 0) {
        return 0;
      }

      const deleteStmt = db.prepare("DELETE FROM digests WHERE digester = ?");
      const result = deleteStmt.run(digester);

      log.info({ digester, deletedCount: result.changes }, "deleted digests for digester");
      return result.changes;
    });

    if (digester === "search-keyword") {
      try {
        const { getMeiliClient } = await import("~/lib/search/meili-client");
        const meiliClient = await getMeiliClient();
        const taskUid = await meiliClient.deleteAllDocuments();
        log.info({ taskUid }, "cleared Meilisearch index");
      } catch (error) {
        log.warn({ error }, "failed to clear Meilisearch index");
      }
    } else if (digester === "search-semantic") {
      try {
        const { getQdrantClient } = await import("~/lib/search/qdrant-client");
        const qdrantClient = await getQdrantClient();
        await qdrantClient.deleteAll();
        log.info({}, "cleared Qdrant collection");
      } catch (error) {
        log.warn({ error }, "failed to clear Qdrant collection");
      }
    }

    ensureAllDigestersForExistingFiles();

    return Response.json({
      message:
        deletedCount > 0
          ? `Successfully deleted ${deletedCount} digest(s)`
          : "No digests found for this digester",
      count: deletedCount,
      digester,
      embeddingsDeleted,
    });
  } catch (error) {
    log.error({ error }, "failed to delete digests");
    return Response.json({ error: "Failed to delete digests" }, { status: 500 });
  }
}
