import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { deletePortalSession, PORTAL_SESSION_COOKIE } from '@/app/lib/portal-auth';

export async function POST(_request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get(PORTAL_SESSION_COOKIE)?.value;

    if (sessionToken) {
      // Delete the session from database
      await deletePortalSession(sessionToken);
    }

    // Clear the session cookie
    cookieStore.delete(PORTAL_SESSION_COOKIE);

    console.log('[Portal Auth] Customer logged out');

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Portal Auth] Error logging out:', error);
    // Still clear the cookie even if there's an error
    const cookieStore = await cookies();
    cookieStore.delete(PORTAL_SESSION_COOKIE);
    return NextResponse.json({ success: true });
  }
}
