/**
 * Application Initialization
 * This module initializes core services when the server starts
 */

import { initializeTaskQueue } from './task-queue/startup';
import { startPeriodicScanner, stopPeriodicScanner } from './scanner/library-scanner';
import { startFileSystemWatcher, stopFileSystemWatcher } from './scanner/fs-watcher';
import { initializeDigesters } from './digest/initialization';
import { startDigestSupervisor, stopDigestSupervisor } from './digest/supervisor';
import { shutdownWorker } from './task-queue/worker';
import { getLogger } from '@/lib/log/logger';

declare global {
  var __mylifedb_app_initialized: boolean | undefined;
  var __mylifedb_shutdown_hooks_registered: boolean | undefined;
}

/**
 * Initialize database and run migrations
 * This ensures the database is set up before any requests are handled
 */
async function initializeDatabase() {
  const log = getLogger({ module: 'AppInit' });
  try {
    log.info({}, 'initializing database');
    const { ensureDatabaseReady } = await import('./db/client');
    ensureDatabaseReady(); // This triggers migrations automatically
    log.info({}, 'database initialized');
  } catch (error) {
    log.error({ err: error }, 'failed to initialize database');
    throw error;
  }
}

/**
 * Initialize search indexes (Meilisearch + Qdrant)
 * This ensures the indexes/collections exist before any documents are indexed
 */
async function initializeSearchIndex() {
  const log = getLogger({ module: 'AppInit' });
  try {
    const { loadSettings } = await import('./config/storage');
    const settings = await loadSettings();

    // Initialize Meilisearch index
    const meiliHost = process.env.MEILI_HOST || settings.vendors?.meilisearch?.host;
    if (meiliHost) {
      log.info({}, 'initializing Meilisearch index');
      const { getMeiliClient } = await import('./search/meili-client');
      await getMeiliClient(); // This triggers ensureIndex() automatically
      log.info({}, 'Meilisearch index initialized');
    } else {
      log.info({}, 'Meilisearch not configured, skipping');
    }

    // Initialize Qdrant collection
    const qdrantHost = settings.vendors?.qdrant?.host;
    if (qdrantHost) {
      log.info({}, 'initializing Qdrant collection');
      const { ensureQdrantCollection } = await import('./search/qdrant-client');
      await ensureQdrantCollection(1024); // Use 1024 dimensions (all-MiniLM-L6-v2)
      log.info({}, 'Qdrant collection initialized');
    } else {
      log.info({}, 'Qdrant not configured, skipping');
    }
  } catch (error) {
    // Don't fail app startup if search is unavailable
    log.warn({ err: error }, 'failed to initialize search indexes, search may be unavailable');
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
    // Initialize digest system (register digesters, sync records)
    initializeDigesters();

    // Initialize task queue and start worker
    initializeTaskQueue({
      startWorker: true,
    });

    // Start file system watcher (real-time file detection)
    startFileSystemWatcher();

    // Start periodic library scanner (fallback)
    startPeriodicScanner();

    // Start digest supervisor loop
    startDigestSupervisor();

    // Register shutdown hooks
    registerShutdownHooks();

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

/**
 * Shutdown application services gracefully
 * Cleans up all background processes, timers, and intervals
 */
export async function shutdownApp(): Promise<void> {
  const log = getLogger({ module: 'AppShutdown' });
  log.debug({}, 'shutting down application services');

  try {
    // Stop digest supervisor
    stopDigestSupervisor();

    // Stop file system watcher
    await stopFileSystemWatcher();

    // Stop library scanner
    stopPeriodicScanner();

    // Shutdown task queue worker (wait for active tasks)
    await shutdownWorker({
      reason: 'app-shutdown',
      timeoutMs: 5000,
    });

    globalThis.__mylifedb_app_initialized = false;
    log.debug({}, 'application shutdown complete');
  } catch (error) {
    log.error({ err: error }, 'error during application shutdown');
  }
}

/**
 * Register process signal handlers for graceful shutdown
 */
function registerShutdownHooks(): void {
  if (globalThis.__mylifedb_shutdown_hooks_registered) {
    return;
  }

  const log = getLogger({ module: 'AppShutdown' });
  globalThis.__mylifedb_shutdown_hooks_registered = true;

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

  signals.forEach(signal => {
    process.on(signal, async () => {
      log.info({ signal }, 'shutdown initiated');
      await shutdownApp();
      process.exit(0);
    });
  });

  // Cleanup on normal exit
  process.on('beforeExit', () => {
    log.debug({}, 'process beforeExit event');
  });

  log.debug({}, 'shutdown hooks registered');
}
