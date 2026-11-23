import { NextRequest, NextResponse, after } from 'next/server'
import {
  getOrganizationBySlug,
  findCustomerByEmail,
  createPortalMagicLink,
  consumePortalThrottle,
} from '@/app/lib/portal-auth'
import { clientIpFromHeaders, throttleKey } from '@/app/lib/app-throttle'
import { getNoReplyFromEmail } from '@/app/lib/email-from'
import { buildRedeemUrl } from '@/lib/portal-url'
import { renderMagicLinkEmail } from './email'

const PER_IP_LIMIT = { max: 10, windowMs: 60 * 1000 }
const PER_EMAIL_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 }
const MAX_EMAIL_LENGTH = 320

/**
 * Emails a one-time portal sign-in link to a customer.
 *
 * SECURITY: the reply must never depend on whether the organization or the
 * customer exists. Every well-formed request gets the same `{ success: true }`,
 * and the lookup-dependent work (token row, email send) runs after the response
 * is on its way, so neither the body nor the response time tells a caller which
 * slugs or addresses are real. Both send limits are counted before any lookup
 * for the same reason.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null)
    const email = body?.email
    const slug = body?.slug

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }
    if (!slug || typeof slug !== 'string') {
      return NextResponse.json({ error: 'Slug is required' }, { status: 400 })
    }

    const normalizedEmail = email.trim().toLowerCase()
    if (normalizedEmail.length > MAX_EMAIL_LENGTH) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const ip = clientIpFromHeaders(request.headers)
    const withinIpLimit = await consumePortalThrottle(
      `portal-magic-link:ip:${ip}`,
      PER_IP_LIMIT
    )
    const withinEmailLimit =
      withinIpLimit &&
      (await consumePortalThrottle(
        throttleKey('portal-magic-link:email', normalizedEmail),
        PER_EMAIL_LIMIT
      ))
    if (!withinIpLimit || !withinEmailLimit) {
      return NextResponse.json(
        {
          error:
            'Too many sign-in links requested. Please wait a few minutes and try again.',
        },
        { status: 429 }
      )
    }

    after(() => deliverMagicLink(normalizedEmail, slug))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[Portal Auth] Error sending magic link:', error)
    return NextResponse.json(
      { error: 'Failed to send magic link' },
      { status: 500 }
    )
  }
}

async function deliverMagicLink(email: string, slug: string): Promise<void> {
  try {
    const organization = await getOrganizationBySlug(slug)
    if (!organization) return

    const customer = await findCustomerByEmail(email, organization.id)
    if (!customer?.email) return

    const token = await createPortalMagicLink(customer.id, organization.id)

    await sendMagicLinkEmail({
      to: customer.email,
      customerName: customer.name,
      organizationName: organization.name,
      organizationLogo: organization.logo,
      magicLinkUrl: buildRedeemUrl(token),
    })

    console.log(
      `[Portal Auth] Magic link processed for customer ${customer.id} (org ${organization.id})`
    )
  } catch (error) {
    console.error('[Portal Auth] Error sending magic link:', error)
  }
}

async function sendMagicLinkEmail({
  to,
  customerName,
  organizationName,
  organizationLogo,
  magicLinkUrl,
}: {
  to: string
  customerName: string
  organizationName: string
  organizationLogo: string | null
  magicLinkUrl: string
}) {
  const apiKey = process.env.RESEND_API_KEY?.trim()

  if (!apiKey) {
    console.log('[Portal Auth] RESEND_API_KEY not configured')
    logUnsentMagicLink(to, magicLinkUrl)
    return
  }

  const { Resend } = await import('resend')
  const resend = new Resend(apiKey)

  const html = renderMagicLinkEmail({
    customerName,
    organizationName,
    organizationLogo,
    magicLinkUrl,
  })

  try {
    await resend.emails.send({
      // Magic links go to end-customers of the merchant. Send from
      // the shared noreply sender so replies don't land in a monitored inbox.
      from: getNoReplyFromEmail() ?? process.env.RESEND_FROM_EMAIL!,
      to,
      subject: `Sign in to ${organizationName}`,
      html,
    })
  } catch (error) {
    console.error('[Portal Auth] Failed to send email via Resend:', error)
    logUnsentMagicLink(to, magicLinkUrl)
  }
}

function logUnsentMagicLink(to: string, magicLinkUrl: string): void {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Portal Auth] Magic link for ${to}: ${magicLinkUrl}`)
  } else {
    console.log(
      '[Portal Auth] Magic link email not sent (login token withheld from logs)'
    )
  }
}
