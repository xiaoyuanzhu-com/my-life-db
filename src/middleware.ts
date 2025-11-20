/**
 * Next.js Middleware
 * Handles authentication and protects routes (if MLD_PASSWORD is set)
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/auth/edge-session';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if password protection is enabled
  const passwordEnabled = process.env.MLD_PASSWORD && process.env.MLD_PASSWORD.trim() !== '';

  // If password protection is disabled, allow all access
  if (!passwordEnabled) {
    return NextResponse.next();
  }

  // Allow access to login page and auth API routes
  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon.ico') ||
    pathname.startsWith('/manifest.webmanifest') ||
    pathname.startsWith('/android-chrome-') ||
    pathname.startsWith('/apple-touch-icon')
  ) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionToken = request.cookies.get('session')?.value;

  if (!sessionToken) {
    // No session, redirect to login
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Verify session token
  const isValid = await verifySessionToken(sessionToken);

  if (!isValid) {
    // Invalid or expired session, redirect to login
    const response = NextResponse.redirect(new URL('/login', request.url));
    // Clear invalid cookie
    response.cookies.set('session', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: '/',
    });
    return response;
  }

  // Valid session, allow access
  return NextResponse.next();
}

// Configure which routes use this middleware
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
