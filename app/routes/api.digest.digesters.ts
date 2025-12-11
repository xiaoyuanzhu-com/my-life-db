import type { LoaderFunctionArgs } from "react-router";
import { globalDigesterRegistry } from "~/.server/digest/registry";
import { initializeDigesters } from "~/.server/digest/initialization";

export async function loader({ request: _request }: LoaderFunctionArgs) {
  initializeDigesters();
  const digesters = globalDigesterRegistry.getDigesterInfo();
  return Response.json({ digesters });
}
