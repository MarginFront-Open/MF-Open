'use client'

import { useEffect, useRef } from 'react'
import * as Sentry from '@sentry/nextjs'
import { useSession, useActiveOrganization } from '@/app/lib/auth-client'
import { isInternalEmail } from '@/lib/internal-email'

/**
 * Stamps the Sentry scope with the current user + active organization so
 * every error captured from the dashboard tells you "who hit this". Resets on
 * logout. Mount once inside the SessionProvider context.
 */
export function SentryIdentifier() {
  const { data: sessionData } = useSession()
  const { data: orgData } = useActiveOrganization()
  const lastUserId = useRef<string | null>(null)
  const lastOrgId = useRef<string | null>(null)

  useEffect(() => {
    const user = sessionData?.user

    if (!user?.id) {
      if (lastUserId.current) {
        Sentry.setUser(null)
        Sentry.setTag('organization_id', undefined)
        Sentry.setTag('organization_name', undefined)
        Sentry.setTag('is_internal', undefined)
        lastUserId.current = null
        lastOrgId.current = null
      }
      return
    }

    if (user.id !== lastUserId.current) {
      Sentry.setUser({
        id: user.id,
        email: user.email,
        username: user.name,
      })
      Sentry.setTag('is_internal', isInternalEmail(user.email))
      lastUserId.current = user.id
    }

    if (orgData?.id && orgData.id !== lastOrgId.current) {
      Sentry.setTag('organization_id', orgData.id)
      Sentry.setTag('organization_name', orgData.name)
      lastOrgId.current = orgData.id
    }
  }, [sessionData, orgData])

  return null
}
