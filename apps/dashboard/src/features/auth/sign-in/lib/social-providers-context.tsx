'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { SocialProviderId } from '@/app/lib/social-providers'

/**
 * Which social sign-in providers this install has credentials for, handed down
 * from the server. The default is "none", so a sign-in button for Google (or
 * any other provider) is never shown unless the server confirmed it is set up.
 */
const SocialProvidersContext = createContext<readonly SocialProviderId[]>([])

export function SocialProvidersProvider({
  providers,
  children,
}: {
  providers: readonly SocialProviderId[]
  children: ReactNode
}) {
  return (
    <SocialProvidersContext.Provider value={providers}>
      {children}
    </SocialProvidersContext.Provider>
  )
}

export function useSocialProviderEnabled(provider: SocialProviderId): boolean {
  return useContext(SocialProvidersContext).includes(provider)
}

export function IfSocialProvider({
  provider,
  children,
}: {
  provider: SocialProviderId
  children: ReactNode
}) {
  return useSocialProviderEnabled(provider) ? <>{children}</> : null
}
