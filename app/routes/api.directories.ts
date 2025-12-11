import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { createDirectory, listDirectories, readDirectory } from "~/.server/fs/storage";
import { z } from "zod";
import { getLogger } from "~/.server/log/logger";

const log = getLogger({ module: "ApiDirectories" });

const CreateDirectorySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parentPath: z.string().default("library"),
});

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const url = new URL(request.url);
    const parentPath = url.searchParams.get("parent") || "library";
    const path = url.searchParams.get("path");

    if (path) {
      const directory = await readDirectory(path);
      if (!directory) {
        return Response.json({ error: "Directory not found" }, { status: 404 });
      }
      return Response.json(directory);
    }

    const directories = await listDirectories(parentPath);
    return Response.json({ directories, total: directories.length });
  } catch (error) {
    log.error({ err: error }, "fetch directories failed");
    return Response.json({ error: "Failed to fetch directories" }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = await request.json();
    const validated = CreateDirectorySchema.parse(body);

    const directory = await createDirectory(
      validated.name,
      validated.description,
      validated.parentPath
    );

    return Response.json(directory, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        { error: "Invalid request data", details: error.issues },
        { status: 400 }
      );
    }

    log.error({ err: error }, "create directory failed");
    return Response.json({ error: "Failed to create directory" }, { status: 500 });
  }
}
