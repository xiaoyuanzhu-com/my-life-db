/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * IMPORTANT: This file provides an "application start" hook that runs BEFORE
 * the HTTP server accepts its first request. This is critical for background
 * services (like the task queue worker) that need to start immediately when
 * the server process starts, not on first user request.
 *
 * Timeline:
 * 1. npm run dev/start
 * 2. Next.js compiles this file
 * 3. register() → onApplicationStart() executes
 * 4. Background services initialize (task queue, etc.)
 * 5. HTTP server becomes ready
 * 6. First request can be handled
 *
 * Use this for:
 * - Background task workers
 * - Cron jobs
 * - Database connection pools
 * - Any service that must run before accepting requests
 */

/**
 * Application startup hook
 * Called once when the server process starts, before accepting HTTP requests
 */
async function onApplicationStart() {
  const { getLogger } = await import('@/lib/log/logger');
  const log = getLogger({ module: 'AppStart' });

  log.info({}, 'application starting...');

  // Initialize core application services
  // This includes task queue worker, which must start before first request
  const { initializeApp } = await import('./lib/init');
  initializeApp();

  log.info({}, 'application started successfully');
}

/**
 * Next.js instrumentation register hook
 * Do not rename this function - Next.js requires it to be called "register"
 */
export async function register() {
  // Only run on Node.js runtime (not Edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await onApplicationStart();
  }
}
