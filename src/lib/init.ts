/**
 * Application Initialization
 * This module initializes core services when the server starts
 */

import { initializeTaskQueue } from './task-queue/startup';
import { getLogger } from '@/lib/log/logger';

declare global {
  var __mylifedb_app_initialized: boolean | undefined;
}

let initialized = globalThis.__mylifedb_app_initialized ?? false;

/**
 * Initialize application services
 * Should be called once on server startup
 */
export function initializeApp() {
  if (initialized) {
    return;
  }

  const log = getLogger({ module: 'AppInit' });
  log.info({}, 'initializing application services');

  try {
    // Initialize task queue and start worker
    initializeTaskQueue({
      verbose: false,
      startWorker: true,
    });

    initialized = true;
    globalThis.__mylifedb_app_initialized = true;
    log.info({}, 'application initialization complete');
  } catch (error) {
    log.error({ err: error }, 'failed to initialize application');
    throw error;
  }
}

/**
 * Check if application is initialized
 */
export function isAppInitialized(): boolean {
  return initialized;
}
