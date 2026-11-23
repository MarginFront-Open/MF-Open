/**
 * Customer portal root layout.
 *
 * Intentionally thin — the org slug isn't known at this depth (it's in the
 * child segment [slug]). Org branding, OrgProvider, and brand colors live
 * in `portal/[slug]/layout.tsx` where `params.slug` is available.
 *
 * The token-redeem route (`portal/r/[token]`) and its org-less fallback
 * (`portal/r/link-error`) also live under this layout but skip the
 * `[slug]` branding entirely.
 */

interface CustomerPortalLayoutProps {
  children: React.ReactNode
}

export default function CustomerPortalLayout({
  children,
}: CustomerPortalLayoutProps) {
  return <div className='min-h-screen bg-background'>{children}</div>
}
