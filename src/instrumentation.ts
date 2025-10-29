/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * This file is called once when the server starts up.
 * Use it to initialize services and background tasks.
 */

import { initializeApp } from './lib/init';

/**
 * Called once on server startup
 */
export async function register() {
  // Only run on Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] Initializing application...');
    initializeApp();
    console.log('[Instrumentation] Application initialized');
  }
}
