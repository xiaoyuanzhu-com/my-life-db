import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import {
  getPeopleById,
  updatePeople,
  deletePeople,
  listClustersForPeople,
  listEmbeddingsForPeople,
} from "~/lib/db/people";
import { getLogger } from "~/lib/log/logger";
import type { VoiceSourceOffset } from "~/types/people-embedding";

const log = getLogger({ module: "ApiPeopleById" });

export async function loader({ params }: LoaderFunctionArgs) {
  try {
    const { id } = params;
    const people = getPeopleById(id!);

    if (!people) {
      return Response.json({ error: "People not found" }, { status: 404 });
    }

    const voiceClusters = listClustersForPeople(id!, "voice");
    const faceClusters = listClustersForPeople(id!, "face");
    const voiceEmbeddings = listEmbeddingsForPeople(id!, "voice");
    const faceEmbeddings = listEmbeddingsForPeople(id!, "face");

    const enrichedVoiceEmbeddings = voiceEmbeddings.map((e) => {
      const sourceOffset = e.sourceOffset as VoiceSourceOffset | null;
      return {
        ...e,
        vector: undefined,
        segmentsWithText: sourceOffset?.segments || [],
      };
    });

    return Response.json({
      ...people,
      clusters: { voice: voiceClusters, face: faceClusters },
      embeddings: {
        voice: enrichedVoiceEmbeddings,
        face: faceEmbeddings.map((e) => ({ ...e, vector: undefined })),
      },
    });
  } catch (error) {
    log.error({ err: error }, "get people failed");
    return Response.json({ error: "Failed to get people" }, { status: 500 });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { id } = params;

  if (request.method === "PUT") {
    try {
      const people = getPeopleById(id!);
      if (!people) {
        return Response.json({ error: "People not found" }, { status: 404 });
      }

      const body = await request.json();
      const { displayName } = body;

      if (!displayName || typeof displayName !== "string") {
        return Response.json({ error: "displayName is required" }, { status: 400 });
      }

      const updatedPeople = updatePeople(id!, { displayName: displayName.trim() });
      log.info({ peopleId: id, displayName }, "updated people");

      return Response.json(updatedPeople);
    } catch (error) {
      log.error({ err: error }, "update people failed");
      return Response.json({ error: "Failed to update people" }, { status: 500 });
    }
  }

  if (request.method === "DELETE") {
    try {
      const people = getPeopleById(id!);
      if (!people) {
        return Response.json({ error: "People not found" }, { status: 404 });
      }

      deletePeople(id!);
      log.info({ peopleId: id, displayName: people.displayName }, "deleted people");

      return Response.json({ success: true });
    } catch (error) {
      log.error({ err: error }, "delete people failed");
      return Response.json({ error: "Failed to delete people" }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
