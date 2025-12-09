import type { ActionFunctionArgs } from "react-router";
import { getPeopleById, mergePeople } from "~/lib/db/people";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiPeopleMerge" });

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const { id: targetId } = params;
    const body = await request.json();
    const { sourceId } = body;

    if (!sourceId || typeof sourceId !== "string") {
      return Response.json({ error: "sourceId is required" }, { status: 400 });
    }

    const target = getPeopleById(targetId!);
    const source = getPeopleById(sourceId);

    if (!target) {
      return Response.json({ error: "Target people not found" }, { status: 404 });
    }
    if (!source) {
      return Response.json({ error: "Source people not found" }, { status: 404 });
    }
    if (targetId === sourceId) {
      return Response.json({ error: "Cannot merge people with itself" }, { status: 400 });
    }

    const mergedPeople = mergePeople(targetId!, sourceId);

    log.info(
      { targetId, sourceId, targetName: target.displayName, sourceName: source.displayName },
      "merged people"
    );

    return Response.json(mergedPeople);
  } catch (error) {
    log.error({ err: error }, "merge people failed");
    return Response.json({ error: "Failed to merge people" }, { status: 500 });
  }
}
