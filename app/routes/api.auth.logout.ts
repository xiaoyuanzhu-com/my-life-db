import type { ActionFunctionArgs } from "react-router";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  return Response.json(
    { success: true },
    {
      headers: {
        "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/",
      },
    }
  );
}
