/**
 * Node.js Runtime Instrumentation
 *
 * This file is ONLY imported when running on Node.js runtime.
 * It can safely use Node.js-specific modules (crypto, fs, sqlite, etc.)
 */

import { getLogger } from '@/lib/log/logger';
import { initializeApp } from './lib/init';

const log = getLogger({ module: 'AppStart' });

/**
 * Application startup for Node.js runtime
 * Called before HTTP server accepts first request
 */
export function onNodeStartup() {
  log.info({}, 'application starting...');
  initializeApp();
  log.info({}, 'application started successfully');
}
