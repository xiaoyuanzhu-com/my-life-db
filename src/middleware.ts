/**
 * Next.js Middleware
 * Ensures application services are initialized before handling requests
 */

import { NextResponse } from 'next/server';

export function middleware() {
  // Just pass through - initialization happens in instrumentation.ts
  return NextResponse.next();
}

// Configure which routes use this middleware (optional - applies to all by default)
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
  runtime: 'nodejs',
};
