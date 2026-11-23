import { notFound } from 'next/navigation'
import { db as prisma } from '@/app/lib/db'
import { OrgProvider } from '@/app/(customer-portal)/context/OrgContext'
import { getCustomerSession } from '@/app/lib/portal-auth'

export interface BrandColors {
  primary: string
  secondary: string
  accent: string
}

interface SlugLayoutProps {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}

/**
 * Per-org portal layout.
 *
 * Resolves the org from the `[slug]` segment in the URL path. Both the
 * (auth) and (main) route groups under this layout inherit OrgProvider
 * + brand CSS variables.
 *
 * If the slug doesn't match any org → 404. This is the routing-layer
 * access control: a random URL like /not-an-org/login returns notFound()
 * instead of a usable login form.
 */
export default async function PortalSlugLayout({
  children,
  params,
}: SlugLayoutProps) {
  const { slug } = await params

  const organization = await prisma.organizations.findFirst({
    where: { slug },
  })

  if (!organization) {
    notFound()
  }

  // Pull brand colors set during onboarding via Firecrawl. Default to the
  // MarginFront brand green if nothing was captured.
  const designJson = organization.designjson as {
    primaryColor?: string
    secondaryColor?: string
    accentColor?: string
    logo?: string
  } | null

  const primaryColor = designJson?.primaryColor || '#10b981'

  const brandColors: BrandColors = {
    primary: primaryColor,
    secondary: designJson?.secondaryColor || primaryColor,
    accent: designJson?.accentColor || primaryColor,
  }

  const customerSession = await getCustomerSession()

  const orgContextValue = {
    organizationName: organization.name,
    organizationSlug: slug,
    organizationLogo: organization.logo || designJson?.logo || null,
    brandColors,
    isImpersonated: customerSession?.isImpersonated || false,
    impersonatedByUserName: customerSession?.impersonatedByUserName || null,
  }

  const hexToRgba = (hex: string, alpha: number): string => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    if (!result) return `rgba(0, 0, 0, ${alpha})`
    return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`
  }

  const cssVars = {
    '--brand-primary': brandColors.primary,
    '--brand-secondary': brandColors.secondary,
    '--brand-accent': brandColors.accent,
    '--brand-primary-light': hexToRgba(brandColors.primary, 0.15),
    '--brand-secondary-light': hexToRgba(brandColors.secondary, 0.15),
    '--brand-accent-light': hexToRgba(brandColors.accent, 0.15),
  } as React.CSSProperties

  return (
    <OrgProvider value={orgContextValue}>
      <div style={cssVars}>{children}</div>
    </OrgProvider>
  )
}
