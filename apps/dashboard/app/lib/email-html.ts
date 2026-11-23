import { copyrightLine } from '@/config/operator'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes a value for use inside email HTML, both as text and inside a quoted
 * attribute. Every organization, customer and user supplied string that goes
 * into an email template must pass through this.
 */
export function escapeHtml(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

/**
 * Returns the URL, HTML-escaped, only when it is a plain http(s) address.
 * Anything else (javascript:, data:, a broken value) returns null so the
 * caller leaves the link or image out.
 */
export function safeHttpUrlForHtml(
  value: string | null | undefined
): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return escapeHtml(url.toString())
  } catch {
    return null
  }
}

const EMAIL_SHAPE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/

/**
 * The "need help?" line at the bottom of sign-in emails. It names the
 * operator's own support address (NEXT_PUBLIC_SUPPORT_EMAIL) and says nothing
 * about support when that is unset, so a fresh install never points its users
 * at an address somebody else controls.
 */
export function supportNoteHtml(): string {
  const supportEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim()
  const notMonitored = 'This email is not monitored for replies.'
  if (!supportEmail || !EMAIL_SHAPE.test(supportEmail)) return notMonitored
  const safe = escapeHtml(supportEmail)
  return `${notMonitored} Need help? Email <a href="mailto:${safe}" style="color: #10b981; text-decoration: underline;">${safe}</a>.`
}

/**
 * The copyright row at the bottom of an email. Empty unless the operator has
 * set a name, so a self-hosted copy never claims someone else's copyright.
 */
export function copyrightFooterHtml(): string {
  const copyright = copyrightLine()
  if (!copyright) return ''
  return `<tr>
            <td align="center" style="padding-top: 24px;">
              <p style="margin: 0; font-size: 12px; color: #525252;">
                ${escapeHtml(copyright)}
              </p>
            </td>
          </tr>`
}
