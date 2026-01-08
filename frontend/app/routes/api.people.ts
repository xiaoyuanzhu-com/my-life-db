import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { listPeopleWithCounts, createPeople, countPeople } from "~/.server/db/people";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiPeople" });

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const pendingOnly = url.searchParams.get("pending") === "true";
    const identifiedOnly = url.searchParams.get("identified") === "true";
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const people = listPeopleWithCounts({ pendingOnly, identifiedOnly, limit, offset });
    const total = countPeople({ pendingOnly, identifiedOnly });

    return Response.json({ people, total, limit, offset });
  } catch (error) {
    log.error({ err: error }, "list people failed");
    return Response.json({ error: "Failed to list people" }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { displayName } = body;

    if (!displayName || typeof displayName !== "string") {
      return Response.json({ error: "displayName is required" }, { status: 400 });
    }

    const people = createPeople({ displayName: displayName.trim() });
    log.info({ peopleId: people.id, displayName }, "created people");

    return Response.json(people, { status: 201 });
  } catch (error) {
    log.error({ err: error }, "create people failed");
    return Response.json({ error: "Failed to create people" }, { status: 500 });
  }
}
