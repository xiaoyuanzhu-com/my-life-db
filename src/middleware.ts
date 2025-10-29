/**
 * Next.js Middleware
 * Ensures application services are initialized before handling requests
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Import initialization but don't call it here (will be called in route handlers)
// Middleware runs in Edge Runtime, so we can't use Node.js APIs here

export function middleware(request: NextRequest) {
  // Just pass through - initialization happens in API routes
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
};
