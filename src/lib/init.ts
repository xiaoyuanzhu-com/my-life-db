/**
 * Application Initialization
 * This module initializes core services when the server starts
 */

import { initializeTaskQueue } from './task-queue/startup';

let initialized = false;

/**
 * Initialize application services
 * Should be called once on server startup
 */
export function initializeApp() {
  if (initialized) {
    return;
  }

  console.log('[App] Initializing application services...');

  try {
    // Initialize task queue and start worker
    // Temporarily verbose for debugging (set to false in production)
    initializeTaskQueue({
      verbose: true,
      startWorker: true,
    });

    initialized = true;
    console.log('[App] Application initialization complete');
  } catch (error) {
    console.error('[App] Failed to initialize application:', error);
    throw error;
  }
}

/**
 * Check if application is initialized
 */
export function isAppInitialized(): boolean {
  return initialized;
}
