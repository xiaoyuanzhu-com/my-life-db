/**
 * Application Initialization
 * This module initializes core services when the server starts
 */

import { initializeTaskQueue } from './task-queue/startup';
import { getLogger } from '@/lib/log/logger';

declare global {
  var __mylifedb_app_initialized: boolean | undefined;
}

/**
 * Initialize application services
 * Should be called once on server startup
 */
export function initializeApp() {
  // Always check globalThis for HMR resilience
  if (globalThis.__mylifedb_app_initialized) {
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

    // Apply log level from user settings (best-effort, async)
    (async () => {
      try {
        const [{ loadSettings }, { setLogLevel }] = await Promise.all([
          import('@/lib/config/storage'),
          import('@/lib/log/logger'),
        ]);
        const settings = await loadSettings();
        const level = settings.preferences?.logLevel;
        if (level) {
          setLogLevel(level as any);
          const l = getLogger({ module: 'AppInit' });
          l.info({ level }, 'log level applied from settings');
        }
      } catch {}
    })();

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
  return globalThis.__mylifedb_app_initialized ?? false;
}
