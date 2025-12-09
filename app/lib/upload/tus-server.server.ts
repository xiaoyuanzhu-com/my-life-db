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

// Handler that wraps TUS server for React Router using handleWeb (for web frameworks)
const handleTusRequest = tusServer.handleWeb.bind(tusServer);

// Ensure upload dir exists on first request
let dirEnsured = false;

export async function handleTus(request: Request) {
  if (!dirEnsured) {
    await ensureUploadDir();
    dirEnsured = true;
  }
  return handleTusRequest(request);
}
