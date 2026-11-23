import { getEnabledSocialProviders } from '@/app/lib/social-providers'
import { SocialProvidersProvider } from '@/features/auth/sign-in/lib/social-providers-context'

export const dynamic = 'force-dynamic'

export default function InviteAcceptLayout({
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
