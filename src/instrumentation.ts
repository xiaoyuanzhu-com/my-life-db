/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * This file is called once when the server starts up.
 * Use it to initialize services and background tasks.
 */

// Defer importing Node-only modules until we confirm Node.js runtime

/**
 * Called once on server startup
 */
export async function register() {
  // Only run on Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getLogger } = await import('@/lib/log/logger');
    const log = getLogger({ module: 'Instrumentation' });
    log.info({}, 'initializing application');
    const { initializeApp } = await import('./lib/init');
    initializeApp();
    log.info({}, 'application initialized');
  }
}
