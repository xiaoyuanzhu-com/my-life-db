import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { Server } from "@tus/server";
import { FileStore } from "@tus/file-store";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";

const DATA_ROOT = process.env.MY_DATA_DIR || path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_ROOT, "app", "my-life-db", "uploads");

// Ensure upload directory exists
async function ensureUploadDir() {
  if (!existsSync(UPLOAD_DIR)) {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  }
}

// Create TUS server instance
const tusServer = new Server({
  path: "/api/upload/tus",
  datastore: new FileStore({ directory: UPLOAD_DIR }),
});

// Handler that wraps TUS server for React Router
async function handleTusRequest(request: Request) {
  await ensureUploadDir();
  return tusServer.handle(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleTusRequest(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return handleTusRequest(request);
}
