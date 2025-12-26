/**
 * Application Initialization
 *
 * This module provides initialization utilities. In production, initialization
 * is handled by server.ts which calls these functions in the correct order.
 *
 * For development with HMR, globalThis guards are still used as a fallback
 * to prevent re-initialization on module reload.
 */

import { startFsWorker, stopFsWorker, setFileChangeHandler } from "./workers/fs-client";
import { startDigestWorker, stopDigestWorker, sendFileChange } from "./workers/digest-client";
import { getLogger } from "~/.server/log/logger";

declare global {
  var __mylifedb_app_initialized: boolean | undefined;
  var __mylifedb_shutdown_hooks_registered: boolean | undefined;
}

/**
 * Initialize application services
 * Called from server.ts on startup
 */
export async function initializeApp(): Promise<void> {
  // HMR guard for development
  if (globalThis.__mylifedb_app_initialized) {
    return;
  }

  const log = getLogger({ module: "AppInit" });
  log.info({}, "initializing application services");

  try {
    // Set up file-change forwarding from FS worker to digest worker
    setFileChangeHandler((msg) => {
      if (msg.type === 'file-change') {
        sendFileChange(msg.filePath, msg.isNew, msg.contentChanged);
      }
    });

    // Start workers (they initialize their own DB connections)
    log.info({}, "starting worker threads");
    await Promise.all([
      startFsWorker(),
      startDigestWorker(),
    ]);

    registerShutdownHooks();

    globalThis.__mylifedb_app_initialized = true;
    log.info({}, "application initialization complete");
  } catch (error) {
    log.error({ err: error }, "failed to initialize application");
    throw error;
  }
}

/**
 * Check if application is initialized
 */
export function isAppInitialized(): boolean {
  return globalThis.__mylifedb_app_initialized ?? false;
}

/**
 * Shutdown application services gracefully
 */
export async function shutdownApp(): Promise<void> {
  const log = getLogger({ module: "AppShutdown" });
  log.debug({}, "shutting down application services");

  try {
    await Promise.all([
      stopFsWorker(),
      stopDigestWorker(),
    ]);

    globalThis.__mylifedb_app_initialized = false;
    log.debug({}, "application shutdown complete");
  } catch (error) {
    log.error({ err: error }, "error during application shutdown");
  }
}

/**
 * Register process signal handlers for graceful shutdown
 */
function registerShutdownHooks(): void {
  if (globalThis.__mylifedb_shutdown_hooks_registered) {
    return;
  }

  const log = getLogger({ module: "AppShutdown" });
  globalThis.__mylifedb_shutdown_hooks_registered = true;

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      log.info({ signal }, "shutdown initiated");
      await shutdownApp();
      process.exit(0);
    });
  });

  log.debug({}, "shutdown hooks registered");
}
