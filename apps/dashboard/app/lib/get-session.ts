import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from './auth';

/**
 * Get the current session on the server side.
 * Returns null if no valid session exists.
 */
export async function getSession() {
  const headersList = await headers();
  const session = await auth.api.getSession({
    headers: headersList,
  });
  return session;
}

/**
 * Require authentication on the server side.
 * Redirects to sign-in page if not authenticated.
 * Returns the session if authenticated.
 */
export async function requireAuth(redirectTo = '/sign-in') {
  const session = await getSession();

  if (!session?.user) {
    redirect(redirectTo);
  }

  return session;
}

/**
 * Get the current user from the session.
 * Returns null if not authenticated.
 */
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Get the active organization ID from the session.
 * Returns null if not authenticated or no organization selected.
 */
export async function getActiveOrganizationId() {
  const session = await getSession();
  return session?.session?.activeOrganizationId ?? null;
}

/**
 * Require organization access on the server side.
 * Redirects if not authenticated or no organization selected.
 */
export async function requireOrgAccess() {
  const session = await requireAuth();
  const orgId = session.session?.activeOrganizationId;

  if (!orgId) {
    redirect('/organizations');
  }

  return { session, orgId };
}
