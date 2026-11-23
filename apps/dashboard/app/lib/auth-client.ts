'use client';

import {
  emailOTPClient,
  inferAdditionalFields,
  organizationClient,
  magicLinkClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import type { auth } from './auth';
import { ac, roles } from './permissions';

/**
 * The base URL for auth API calls, in this order:
 * - On localhost: the page's own origin.
 * - NEXT_PUBLIC_BETTER_AUTH_URL when it is set.
 * - In the browser: window.location.origin, which works for any preview URL.
 * - During SSR with neither: '' so Better Auth uses relative URLs.
 *
 * Only NEXT_PUBLIC_* variables reach the client bundle, so a host's
 * server-side URL variable can't be read here.
 */
function getAuthBaseURL(): string {
  // A NEXT_PUBLIC_BETTER_AUTH_URL baked in at compile time pins every browser
  // request to that host, so a dev server on any other port (e.g. :3005)
  // would silently post to :3000. Same-origin wins on localhost.
  if (
    typeof window !== 'undefined' &&
    window.location.hostname === 'localhost'
  ) {
    return window.location.origin;
  }

  if (process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    return process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  }

  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  // Requests made after hydration go through customFetchImpl below, which
  // resolves them against window.location.origin.
  return '';
}

const initialBaseURL = getAuthBaseURL();

export const authClient = createAuthClient({
  baseURL: initialBaseURL || undefined,
  plugins: [
    organizationClient({ ac, roles }),
    inferAdditionalFields<typeof auth>(),
    emailOTPClient(),
    magicLinkClient(),
  ],
  fetchOptions: {
    // In the browser, rewrite a localhost URL (baked in at build time) and
    // any relative URL onto the page's own origin.
    customFetchImpl: async (input, options) => {
      let finalUrl: string | Request | URL = input;

      if (typeof window !== 'undefined') {
        const urlString = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;

        try {
          const urlObj = new URL(urlString, window.location.origin);

          if (urlObj.hostname === 'localhost' && window.location.hostname !== 'localhost') {
            urlObj.protocol = window.location.protocol;
            urlObj.host = window.location.host;
            finalUrl = urlObj.href;
          }
          else if (urlString.startsWith('/')) {
            finalUrl = `${window.location.origin}${urlString}`;
          }
        } catch {
          finalUrl = input;
        }
      }

      return fetch(finalUrl, options);
    },
  },
});

export const {
  signIn,
  signOut,
  signUp,
  useSession,
  useActiveOrganization,
  useListOrganizations,
  organization,
  emailOtp,
} = authClient;

export async function isAuthenticated(): Promise<boolean> {
  try {
    const { data } = await authClient.getSession();
    return !!data?.session;
  } catch {
    return false;
  }
}
