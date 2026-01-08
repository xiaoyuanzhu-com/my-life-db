import type { ActionFunctionArgs } from "react-router";
import { verifyPassword, createSession } from "~/.server/db/sessions";
import { createSessionToken } from "~/.server/auth/edge-session";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const { password } = body;

    if (!password || typeof password !== "string") {
      return Response.json({ error: "Password is required" }, { status: 400 });
    }

    const isValid = verifyPassword(password);
    if (!isValid) {
      return Response.json({ error: "Invalid password" }, { status: 401 });
    }

    createSession();
    const sessionToken = await createSessionToken();

    return Response.json(
      { success: true },
      {
        headers: {
          "Set-Cookie": `session=${sessionToken}; HttpOnly; ${
            process.env.NODE_ENV === "production" ? "Secure; " : ""
          }SameSite=Lax; Max-Age=${365 * 24 * 60 * 60}; Path=/`,
        },
      }
    );
  } catch (error) {
    console.error("Login error:", error);
    return Response.json(
      { error: "An error occurred during login" },
      { status: 500 }
    );
  }
}
