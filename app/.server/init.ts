/**
 * Application Initialization
 *
 * This module provides initialization utilities. In production, initialization
 * is handled by server.ts which calls these functions in the correct order.
 *
 * For development with HMR, globalThis guards are still used as a fallback
 * to prevent re-initialization on module reload.
 */

import { startPeriodicScanner, stopPeriodicScanner } from "./scanner/library-scanner";
import { startFileSystemWatcher, stopFileSystemWatcher } from "./scanner/fs-watcher";
import { initializeDigesters } from "./digest/initialization";
import { startDigestSupervisor, stopDigestSupervisor } from "./digest/supervisor";
import { getLogger } from "~/.server/log/logger";

declare global {
  var __mylifedb_app_initialized: boolean | undefined;
  var __mylifedb_shutdown_hooks_registered: boolean | undefined;
}

/**
 * Initialize application services
 * Called from server.ts on startup
 */
export function initializeApp() {
  // HMR guard for development
  if (globalThis.__mylifedb_app_initialized) {
    return;
  }

  const log = getLogger({ module: "AppInit" });
  log.info({}, "initializing application services");

  try {
    initializeDigesters();
    startFileSystemWatcher();
    startPeriodicScanner();
    startDigestSupervisor();
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
    stopDigestSupervisor();
    await stopFileSystemWatcher();
    stopPeriodicScanner();

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
