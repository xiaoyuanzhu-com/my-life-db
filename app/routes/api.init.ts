/**
 * Initialization API endpoint
 *
 * Called by server.js on production startup to initialize all services.
 * This route exists solely to trigger the initialization code path.
 */

import { initializeApp, isAppInitialized } from "~/.server/init";
import { ensureDatabaseReady } from "~/.server/db/client";

export async function loader() {
  if (isAppInitialized()) {
    return Response.json({ status: "already_initialized" });
  }

  // Initialize database first (required before other services)
  ensureDatabaseReady();

  // Initialize all other services
  initializeApp();
  return Response.json({ status: "initialized" });
}
