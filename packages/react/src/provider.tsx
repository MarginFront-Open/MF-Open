"use client";

import { useState, useEffect, useMemo, type ReactNode } from "react";
import {
  MarginFrontClient,
  parseApiKey,
  type ApiKeyType,
} from "@marginfront/sdk";
import {
  MarginFrontContext,
  defaultTheme,
  type MarginFrontTheme,
  type AuthMode,
} from "./context";
import { requireApiBaseUrl } from "./api-base-url";

/**
 * Props for MarginFrontProvider
 *
 * Three authentication modes are supported:
 *
 * Every mode needs apiBaseUrl: the address of your own MarginFront API,
 * including /v1. There is no built-in default.
 *
 * 1. API Key Mode (standard SDK usage):
 *    ```tsx
 *    <MarginFrontProvider apiKey="mf_sk_xxx" apiBaseUrl="https://billing.example.com/v1">
 *      <YourApp />
 *    </MarginFrontProvider>
 *    ```
 *
 * 2. Portal Session Mode (customer portal):
 *    ```tsx
 *    <MarginFrontProvider
 *      sessionToken="prtl_xxx"
 *      apiBaseUrl="https://billing.example.com/v1"
 *    >
 *      <CustomerPortal />
 *    </MarginFrontProvider>
 *    ```
 *
 * 3. Public Mode (pricing pages, no auth):
 *    ```tsx
 *    <MarginFrontProvider
 *      orgSlug="acme-corp"
 *      apiBaseUrl="https://billing.example.com/v1"
 *    >
 *      <PricingPage />
 *    </MarginFrontProvider>
 *    ```
 */
export interface MarginFrontProviderProps {
  /**
   * API key for SDK authentication (mf_sk_* or mf_pk_*)
   * Use this for standard SDK operations
   */
  apiKey?: string;

  /**
   * Portal session token (prtl_*)
   * Use this for customer portal access
   * Requires sessionToken from portalSessions.create()
   */
  sessionToken?: string;

  /**
   * Organization slug or ID for public endpoints
   * Use this for pricing pages without authentication
   */
  orgSlug?: string;

  /** Customer ID for customer-specific queries */
  customerId?: string;
  /** Organization ID (optional, derived from API key) */
  orgId?: string;
  /** Address of your own MarginFront API, including /v1. Required: there is no default. */
  apiBaseUrl: string;
  /** Theme customization */
  theme?: Partial<MarginFrontTheme>;
  /** Child components */
  children: ReactNode;
  /** Callback when connected */
  onConnect?: (client: MarginFrontClient) => void;
  /** Callback on connection error */
  onError?: (error: Error) => void;
}

/**
 * Determine the authentication mode based on provided props
 */
function determineAuthMode(
  props: Pick<MarginFrontProviderProps, "apiKey" | "sessionToken" | "orgSlug">,
): AuthMode {
  if (props.sessionToken) {
    return "portalSession";
  }
  if (props.apiKey) {
    return "apiKey";
  }
  if (props.orgSlug) {
    return "public";
  }
  return "apiKey"; // Default fallback
}

/**
 * MarginFrontProvider - Wraps your app to provide MarginFront context
 *
 * Supports three authentication modes:
 *
 * @example API Key Mode (standard SDK usage)
 * ```tsx
 * import { MarginFrontProvider } from '@marginfront/react';
 *
 * function App() {
 *   return (
 *     <MarginFrontProvider
 *       apiKey="mf_sk_your_key"
 *       apiBaseUrl="https://billing.example.com/v1"
 *       customerId="cust_123"
 *       theme={{ primary: '#000000' }}
 *     >
 *       <YourApp />
 *     </MarginFrontProvider>
 *   );
 * }
 * ```
 *
 * @example Portal Session Mode (customer portal)
 * ```tsx
 * // Server-side: Create portal session
 * const session = await marginfront.portalSessions.create({
 *   customerId: 'cust_123',
 *   returnUrl: '/account'
 * });
 *
 * // Client-side: Use session token
 * <MarginFrontProvider
 *   sessionToken={session.token}
 *   apiBaseUrl="https://billing.example.com/v1"
 * >
 *   <CustomerPortal />
 * </MarginFrontProvider>
 * ```
 *
 * @example Public Mode (pricing pages)
 * ```tsx
 * <MarginFrontProvider orgSlug="acme-corp" apiBaseUrl="https://billing.example.com/v1">
 *   <PricingTable />
 * </MarginFrontProvider>
 * ```
 */
export function MarginFrontProvider({
  apiKey,
  sessionToken,
  orgSlug,
  customerId,
  orgId,
  apiBaseUrl: apiBaseUrlProp,
  theme: themeProp,
  children,
  onConnect,
  onError,
}: MarginFrontProviderProps) {
  const apiBaseUrl = requireApiBaseUrl(apiBaseUrlProp);
  const [client, setClient] = useState<MarginFrontClient | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [resolvedOrgId, setResolvedOrgId] = useState<string | null>(
    orgId || null,
  );
  const [resolvedCustomerId, setResolvedCustomerId] = useState<string | null>(
    customerId || null,
  );
  const [keyType, setKeyType] = useState<ApiKeyType | null>(null);

  // Sync props to state (useState initializer only runs on mount)
  useEffect(() => {
    setResolvedCustomerId(customerId || null);
  }, [customerId]);

  useEffect(() => {
    setResolvedOrgId(orgId || null);
  }, [orgId]);

  // Determine auth mode
  const authMode = useMemo(
    () => determineAuthMode({ apiKey, sessionToken, orgSlug }),
    [apiKey, sessionToken, orgSlug],
  );

  // Check if this is a customer portal context
  const isCustomerPortal = authMode === "portalSession";

  // Merge theme with defaults
  const theme = useMemo(() => ({ ...defaultTheme, ...themeProp }), [themeProp]);

  // Initialize based on auth mode
  useEffect(() => {
    const initClient = async () => {
      try {
        setIsConnecting(true);
        setError(null);

        if (authMode === "apiKey" && apiKey) {
          // Standard API key mode
          const newClient = new MarginFrontClient(apiKey, {
            baseUrl: apiBaseUrl,
            timeout: 30000,
            retries: 2,
          });

          // Parse key info
          const keyInfo = parseApiKey(apiKey);
          if (keyInfo) {
            setKeyType(keyInfo.type);
          }

          // Verify connection
          await newClient.connect();
          const org = newClient.getOrganization();

          setClient(newClient);
          setResolvedOrgId(org.id);
          setIsConnected(true);
          onConnect?.(newClient);
        } else if (authMode === "portalSession" && sessionToken) {
          // Portal session mode - no SDK client, use direct fetch
          // Verify session by fetching session info
          const response = await fetch(`${apiBaseUrl}/portal/session`, {
            headers: {
              Authorization: `Bearer ${sessionToken}`,
            },
          });

          if (!response.ok) {
            throw new Error("Invalid or expired portal session");
          }

          const sessionInfo = await response.json();
          setResolvedOrgId(sessionInfo.organizationId || null);
          setResolvedCustomerId(sessionInfo.customerId || customerId || null);
          setIsConnected(true);

          console.log("[MarginFront] Portal session verified");
        } else if (authMode === "public" && orgSlug) {
          // Public mode - verify org exists
          const response = await fetch(
            `${apiBaseUrl}/public/org/${orgSlug}/config`,
          );

          if (!response.ok) {
            throw new Error(`Organization not found: ${orgSlug}`);
          }

          const orgConfig = await response.json();
          setResolvedOrgId(orgConfig.id);
          setIsConnected(true);

          console.log("[MarginFront] Public mode initialized for:", orgConfig.name);
        } else {
          throw new Error(
            "MarginFrontProvider requires one of: apiKey, sessionToken, or orgSlug",
          );
        }
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new Error("Failed to connect to MarginFront");
        setError(error);
        onError?.(error);
        console.error("[MarginFront] Connection failed:", error);
      } finally {
        setIsConnecting(false);
      }
    };

    initClient();
  }, [
    apiKey,
    sessionToken,
    orgSlug,
    apiBaseUrl,
    authMode,
    onConnect,
    onError,
    customerId,
  ]);

  const contextValue = useMemo(
    () => ({
      client,
      isConnected,
      isConnecting,
      error,
      orgId: resolvedOrgId,
      orgSlug: orgSlug || null,
      customerId: resolvedCustomerId,
      theme,
      apiBaseUrl,
      // Session-based auth fields
      authMode,
      sessionToken: sessionToken || null,
      isCustomerPortal,
      keyType,
    }),
    [
      client,
      isConnected,
      isConnecting,
      error,
      resolvedOrgId,
      orgSlug,
      resolvedCustomerId,
      theme,
      apiBaseUrl,
      authMode,
      sessionToken,
      isCustomerPortal,
      keyType,
    ],
  );

  return (
    <MarginFrontContext.Provider value={contextValue}>
      {children}
    </MarginFrontContext.Provider>
  );
}
