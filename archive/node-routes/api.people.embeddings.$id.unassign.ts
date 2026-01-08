import type { ActionFunctionArgs } from "react-router";
import { getEmbeddingById, unassignEmbedding } from "~/.server/db/people";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiEmbeddingUnassign" });

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { id: embeddingId } = params;

    const embedding = getEmbeddingById(embeddingId!);
    if (!embedding) {
      return Response.json({ error: "Embedding not found" }, { status: 404 });
    }

    const previousClusterId = embedding.clusterId;
    unassignEmbedding(embeddingId!);

    const updatedEmbedding = getEmbeddingById(embeddingId!);

    log.info({ embeddingId, previousClusterId }, "unassigned embedding from cluster");

    return Response.json({
      embedding: updatedEmbedding ? { ...updatedEmbedding, vector: undefined } : null,
    });
  } catch (error) {
    log.error({ err: error }, "unassign embedding failed");
    return Response.json({ error: "Failed to unassign embedding" }, { status: 500 });
  }
}
