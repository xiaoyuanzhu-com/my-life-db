/**
 * Application Initialization
 * This module initializes core services when the server starts
 */

import { initializeTaskQueue } from './task-queue/startup';
import { startPeriodicScanner } from './scanner/libraryScanner';
import { getLogger } from '@/lib/log/logger';

declare global {
  var __mylifedb_app_initialized: boolean | undefined;
}

/**
 * Initialize database and run migrations
 * This ensures the database is set up before any requests are handled
 */
async function initializeDatabase() {
  const log = getLogger({ module: 'AppInit' });
  try {
    log.info({}, 'initializing database');
    const { getDatabase } = await import('./db/connection');
    getDatabase(); // This triggers migrations automatically
    log.info({}, 'database initialized');
  } catch (error) {
    log.error({ err: error }, 'failed to initialize database');
    throw error;
  }
}

/**
 * Initialize search index (Meilisearch)
 * This ensures the index exists before any documents are indexed
 */
async function initializeSearchIndex() {
  const log = getLogger({ module: 'AppInit' });
  try {
    const { getMeiliClient } = await import('./search/meili-client');
    const { loadSettings } = await import('./config/storage');

    // Check if Meilisearch is configured
    const settings = await loadSettings();
    const host = process.env.MEILI_HOST || settings.vendors?.meilisearch?.host;

    if (!host) {
      log.info({}, 'Meilisearch not configured, skipping index initialization');
      return;
    }

    log.info({}, 'initializing Meilisearch index');
    await getMeiliClient(); // This triggers ensureIndex() automatically
    log.info({}, 'Meilisearch index initialized');
  } catch (error) {
    // Don't fail app startup if search is unavailable
    log.warn({ err: error }, 'failed to initialize Meilisearch index, search will be unavailable');
  }
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
      startWorker: true,
    });

    // Start periodic library scanner
    startPeriodicScanner();

    // Run async initialization tasks (database, search, settings)
    (async () => {
      try {
        // 1. Initialize database and run migrations
        await initializeDatabase();

        // 2. Initialize search index
        await initializeSearchIndex();

        // 3. Apply log level from user settings
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

        log.info({}, 'async initialization complete');
      } catch (error) {
        log.error({ err: error }, 'async initialization failed');
      }
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
