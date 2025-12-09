import type { ActionFunctionArgs } from "react-router";
import { getEmbeddingById, getPeopleById, assignEmbeddingToPeople } from "~/lib/db/people";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiEmbeddingAssign" });

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { id: embeddingId } = params;
    const body = await request.json();
    const { peopleId } = body;

    if (!peopleId || typeof peopleId !== "string") {
      return Response.json({ error: "peopleId is required" }, { status: 400 });
    }

    const embedding = getEmbeddingById(embeddingId!);
    if (!embedding) {
      return Response.json({ error: "Embedding not found" }, { status: 404 });
    }

    const people = getPeopleById(peopleId);
    if (!people) {
      return Response.json({ error: "People not found" }, { status: 404 });
    }

    const result = assignEmbeddingToPeople(embeddingId!, peopleId);

    log.info(
      { embeddingId, peopleId, clusterId: result.cluster.id, peopleName: people.displayName },
      "assigned embedding to people"
    );

    return Response.json({
      embedding: { ...result.embedding, vector: undefined },
      cluster: { ...result.cluster, centroid: undefined },
    });
  } catch (error) {
    log.error({ err: error }, "assign embedding failed");
    return Response.json({ error: "Failed to assign embedding" }, { status: 500 });
  }
}
