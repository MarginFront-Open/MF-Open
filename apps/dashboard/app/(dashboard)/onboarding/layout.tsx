import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Onboarding | MarginFront',
  description: 'Set up your usage-based billing with MarginFront',
}

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Onboarding has its own full-screen layout, so we just render children
  // without the dashboard sidebar/header
  return <>{children}</>
}
