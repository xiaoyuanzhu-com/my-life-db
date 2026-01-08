import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { handleTus } from "~/.server/upload/tus-server.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return handleTus(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleTus(request);
}
