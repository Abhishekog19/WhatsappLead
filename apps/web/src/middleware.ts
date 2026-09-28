import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cheap redirect for unauthenticated visitors.
 *
 * This only checks that a session cookie EXISTS — it deliberately does not
 * validate it. Sessions live in Postgres, and the Edge runtime has no database
 * access, so real enforcement happens in the dashboard layout via
 * requireUser(). Treat this purely as a UX optimisation that saves a render.
 *
 * Security consequence: forging the cookie gets you a redirect to a page that
 * then checks properly and sends you back. Nothing is authorised here.
 */

const PROTECTED = ['/dashboard'];

function hasSessionCookie(req: NextRequest): boolean {
  return (
    req.cookies.has('authjs.session-token') ||
    req.cookies.has('__Secure-authjs.session-token')
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const signedIn = hasSessionCookie(req);

  if (PROTECTED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (!signedIn) {
      const url = new URL('/signin', req.url);
      url.searchParams.set('next', pathname);
      return NextResponse.redirect(url);
    }
  }

  // Someone already signed in has no use for the sign-in page.
  if (pathname === '/signin' && signedIn) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/signin'],
};
