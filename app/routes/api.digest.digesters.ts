import type { LoaderFunctionArgs } from "react-router";
import { globalDigesterRegistry } from "~/lib/digest/registry";
import { initializeDigesters } from "~/lib/digest/initialization";

export async function loader({ request }: LoaderFunctionArgs) {
  initializeDigesters();
  const digesters = globalDigesterRegistry.getDigesterInfo();
  return Response.json({ digesters });
}
