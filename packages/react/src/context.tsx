'use client';

import { createContext, useContext } from 'react';
import type { MarginFrontClient, ApiKeyType } from '@marginfront/sdk';

/**
 * Theme configuration for MarginFront components
 */
export interface MarginFrontTheme {
  /** Primary brand color (hex) */
  primary?: string;
  /** Secondary color (hex) */
  secondary?: string;
  /** Accent color (hex) */
  accent?: string;
  /** Border radius (e.g., '8px', '0.5rem') */
  borderRadius?: string;
  /** Font family */
  fontFamily?: string;
}

/**
 * Authentication mode for the MarginFront client
 *
 * - 'apiKey': Using an API key (sk_* or pk_*) - standard SDK mode
 * - 'portalSession': Using a portal session token (prtl_*) - customer portal mode
 * - 'public': Using public endpoints only (no auth) - pricing page mode
 */
export type AuthMode = 'apiKey' | 'portalSession' | 'public';

/**
 * Context value for MarginFront provider
 */
export interface MarginFrontContextValue {
  /** SDK client instance (null in portal session or public mode) */
  client: MarginFrontClient | null;
  /** Whether the client is connected */
  isConnected: boolean;
  /** Whether the client is connecting */
  isConnecting: boolean;
  /** Connection error if any */
  error: Error | null;
  /** Organization ID */
  orgId: string | null;
  /** Organization slug (for public endpoints) */
  orgSlug: string | null;
  /** Customer ID (for customer-specific queries) */
  customerId: string | null;
  /** Theme configuration */
  theme: MarginFrontTheme;
  /** Address of the MarginFront API, as passed to MarginFrontProvider */
  apiBaseUrl: string;

  // Session-based auth
  /** Current authentication mode */
  authMode: AuthMode;
  /** Portal session token (when in portalSession mode) */
  sessionToken: string | null;
  /** Whether this is a customer portal context */
  isCustomerPortal: boolean;
  /** API key type (secret or publishable) */
  keyType: ApiKeyType | null;
}

const defaultTheme: MarginFrontTheme = {
  primary: '#047857',
  secondary: '#6B7280',
  accent: '#10B981',
  borderRadius: '8px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
};

const defaultContextValue: MarginFrontContextValue = {
  client: null,
  isConnected: false,
  isConnecting: false,
  error: null,
  orgId: null,
  orgSlug: null,
  customerId: null,
  theme: defaultTheme,
  apiBaseUrl: '',
  // Session-based auth defaults
  authMode: 'apiKey',
  sessionToken: null,
  isCustomerPortal: false,
  keyType: null,
};

export const MarginFrontContext = createContext<MarginFrontContextValue>(defaultContextValue);

/**
 * Hook to access MarginFront context
 * @throws Error if used outside MarginFrontProvider
 */
export function useMarginFrontContext(): MarginFrontContextValue {
  const context = useContext(MarginFrontContext);
  if (!context.client && !context.isConnecting) {
    console.warn(
      '[MarginFront] useMarginFrontContext called outside of MarginFrontProvider. ' +
      'Make sure to wrap your app with <MarginFrontProvider>.'
    );
  }
  return context;
}

export { defaultTheme };
