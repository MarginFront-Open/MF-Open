export function internalEmailDomains(
  configured: string | undefined = process.env
    .NEXT_PUBLIC_INTERNAL_EMAIL_DOMAINS
): string[] {
  return (configured ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter((domain) => domain.length > 0)
}

export function isInternalEmail(
  email: string | null | undefined,
  domains: string[] = internalEmailDomains()
): boolean {
  if (!email) return false
  const at = email.lastIndexOf('@')
  if (at < 1) return false
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return domains.some((d) => domain === d || domain.endsWith('.' + d))
}
