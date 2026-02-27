import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { isLocalModeEnabled } from '@/lib/runtime';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
  '/api/webhooks/(.*)',
  '/api/services(.*)',
  '/api/availability(.*)',
  '/api/bookings/mock(.*)',
  '/api/bookings/slots',
]);

const clerkAuthMiddleware = clerkMiddleware((auth, req) => {
  if (!isPublicRoute(req)) {
    auth().protect();
  }
});

export default function middleware(req: NextRequest, event: Parameters<typeof clerkAuthMiddleware>[1]) {
  if (isLocalModeEnabled()) {
    return NextResponse.next();
  }

  return clerkAuthMiddleware(req, event);
}

export const config = {
  matcher: ['/((?!.+\\.[\\w]+$|_next).*)', '/', '/(api|trpc)(.*)'],
};
