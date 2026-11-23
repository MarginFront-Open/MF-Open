import { getEnabledSocialProviders } from '@/app/lib/social-providers'
import { SocialProvidersProvider } from '@/features/auth/sign-in/lib/social-providers-context'

// Force dynamic rendering for all auth pages. This also means the provider
// list below is read from the running server's environment on each request,
// not frozen at build time.
export const dynamic = 'force-dynamic'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <SocialProvidersProvider providers={getEnabledSocialProviders()}>
      {children}
    </SocialProvidersProvider>
  )
}
