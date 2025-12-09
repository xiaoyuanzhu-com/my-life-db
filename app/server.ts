/**
 * Express Server Entry Point
 *
 * This is the main entry point for the application. All initialization
 * happens here BEFORE accepting HTTP requests - no more globalThis guards,
 * no async IIFE patterns, just clean sequential startup.
 */

import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createRequestHandler } from "@react-router/express";
import { getLogger, setLogLevel } from "~/lib/log/logger";
import { ensureDatabaseReady } from "~/lib/db/client";
import { loadSettings } from "~/lib/config/storage";
import { initializeDigesters } from "~/lib/digest/initialization";
import { initializeTaskQueue } from "~/lib/task-queue/startup";
import { startFileSystemWatcher, stopFileSystemWatcher } from "~/lib/scanner/fs-watcher";
import { startPeriodicScanner, stopPeriodicScanner } from "~/lib/scanner/library-scanner";
import { startDigestSupervisor, stopDigestSupervisor } from "~/lib/digest/supervisor";
import { shutdownWorker } from "~/lib/task-queue/worker";

const log = getLogger({ module: "Server" });
const PORT = process.env.PORT || 3000;

/**
 * Initialize all services before accepting requests
 */
async function initialize() {
  log.info({}, "starting application initialization");

  // 1. Initialize database and run migrations
  log.info({}, "initializing database");
  ensureDatabaseReady();
  log.info({}, "database ready");

  // 2. Load settings and apply log level
  const settings = await loadSettings();
  const logLevel = settings.preferences?.logLevel;
  const validLogLevels = ['debug', 'info', 'warn', 'error'] as const;
  if (logLevel && validLogLevels.includes(logLevel as typeof validLogLevels[number])) {
    setLogLevel(logLevel as typeof validLogLevels[number]);
    log.info({ level: logLevel }, "log level applied from settings");
  }

  // 3. Initialize search indexes (optional, non-blocking)
  await initializeSearchIndexes(settings);

  // 4. Initialize digest system
  log.info({}, "initializing digest system");
  initializeDigesters();
  log.info({}, "digest system ready");

  // 5. Initialize task queue and start worker
  log.info({}, "initializing task queue");
  initializeTaskQueue({ startWorker: true });
  log.info({}, "task queue ready");

  // 6. Start file system watcher
  log.info({}, "starting file system watcher");
  startFileSystemWatcher();
  log.info({}, "file system watcher started");

  // 7. Start periodic scanner (fallback)
  log.info({}, "starting periodic scanner");
  startPeriodicScanner();
  log.info({}, "periodic scanner started");

  // 8. Start digest supervisor
  log.info({}, "starting digest supervisor");
  startDigestSupervisor();
  log.info({}, "digest supervisor started");

  log.info({}, "application initialization complete");
}

/**
 * Initialize search indexes (Meilisearch + Qdrant)
 */
async function initializeSearchIndexes(settings: Awaited<ReturnType<typeof loadSettings>>) {
  // Initialize Meilisearch
  const meiliHost = process.env.MEILI_HOST || settings.vendors?.meilisearch?.host;
  if (meiliHost) {
    try {
      log.info({}, "initializing Meilisearch index");
      const { getMeiliClient } = await import("~/lib/search/meili-client");
      await getMeiliClient();
      log.info({}, "Meilisearch index ready");
    } catch (error) {
      log.warn({ err: error }, "failed to initialize Meilisearch, search may be unavailable");
    }
  } else {
    log.info({}, "Meilisearch not configured, skipping");
  }

  // Initialize Qdrant
  const qdrantHost = settings.vendors?.qdrant?.host;
  if (qdrantHost) {
    try {
      log.info({}, "initializing Qdrant collection");
      const { ensureQdrantCollection } = await import("~/lib/search/qdrant-client");
      await ensureQdrantCollection(1024);
      log.info({}, "Qdrant collection ready");
    } catch (error) {
      log.warn({ err: error }, "failed to initialize Qdrant, semantic search may be unavailable");
    }
  } else {
    log.info({}, "Qdrant not configured, skipping");
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string) {
  log.info({ signal }, "shutdown initiated");

  try {
    // Stop accepting new requests (handled by server.close())

    // Stop background services in reverse order
    stopDigestSupervisor();
    stopPeriodicScanner();
    await stopFileSystemWatcher();
    await shutdownWorker({ reason: "server-shutdown", timeoutMs: 5000 });

    log.info({}, "shutdown complete");
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, "error during shutdown");
    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main() {
  // Initialize all services first
  await initialize();

  // Create Express app
  const app = express();

  // Trust proxy for correct client IP
  app.set("trust proxy", true);

  // Compression middleware
  app.use(compression());

  // Request logging
  if (process.env.NODE_ENV === "development") {
    app.use(morgan("dev"));
  }

  // Static files from public directory
  app.use(express.static("public", { maxAge: "1h" }));

  // React Router request handler
  app.all(
    "*",
    createRequestHandler({
      build: () => import("virtual:react-router/server-build"),
      getLoadContext() {
        // Add any custom context here if needed
        return {};
      },
    })
  );

  // Start server
  const server = app.listen(PORT, () => {
    log.info({ port: PORT }, "server listening");
    console.log(`Server running at http://localhost:${PORT}`);
  });

  // Handle shutdown signals
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    log.error({ err: error }, "uncaught exception");
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled rejection");
  });

  return server;
}

// Run the server
main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
