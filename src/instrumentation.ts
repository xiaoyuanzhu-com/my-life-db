/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * IMPORTANT: This file provides an "application start" hook that runs BEFORE
 * the HTTP server accepts its first request. This is critical for background
 * services (like the task queue worker) that need to start immediately when
 * the server process starts, not on first user request.
 *
 * This file is compiled for ALL runtimes (Node.js + Edge).
 * Runtime-specific code is in separate files (instrumentation-node.ts).
 *
 * Timeline:
 * 1. npm run dev/start
 * 2. Next.js compiles this file for all runtimes
 * 3. register() executes, dynamically imports Node.js-specific code
 * 4. Background services initialize (task queue, etc.)
 * 5. HTTP server becomes ready
 * 6. First request can be handled
 */

/**
 * Next.js instrumentation register hook
 * Do not rename this function - Next.js requires it to be called "register"
 *
 * Per Next.js docs: "Next.js calls register in all environments, so it's
 * important to conditionally import any code that doesn't support specific runtimes."
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Dynamic import prevents Node.js modules from being bundled for Edge runtime
    const { onNodeStartup } = await import('./instrumentation-node');
    onNodeStartup();
  }
}
