import { getOperatorSettings } from '@/config/operator'

const LINK_CLASS =
  'underline underline-offset-4 transition-colors hover:text-foreground'

/**
 * "By continuing, you agree to our Terms and Privacy Policy", built from the
 * operator's NEXT_PUBLIC_TERMS_URL and NEXT_PUBLIC_PRIVACY_URL. Names only the
 * documents that are configured and renders nothing when neither is.
 */
export function LegalConsentLine({ className }: { className?: string }) {
  const { termsUrl, privacyUrl } = getOperatorSettings()
  if (!termsUrl && !privacyUrl) return null

  const terms = termsUrl ? (
    <a
      href={termsUrl}
      target='_blank'
      rel='noopener noreferrer'
      className={LINK_CLASS}
    >
      Terms
    </a>
  ) : null
  const privacy = privacyUrl ? (
    <a
      href={privacyUrl}
      target='_blank'
      rel='noopener noreferrer'
      className={LINK_CLASS}
    >
      Privacy Policy
    </a>
  ) : null

  return (
    <p className={className}>
      By continuing, you agree to our {terms}
      {terms && privacy ? ' and ' : null}
      {privacy}
    </p>
  )
}
