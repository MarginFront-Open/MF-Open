'use server'

import { Resend } from 'resend'
import { generateCustomerPortalLink } from './generate-customer-portal-link'
import { assertPortalManager } from './_shared/assert-portal-manager'
import { escapeHtml } from '@/app/lib/email-html'
import { copyrightLine } from '@/config/operator'

export interface SendPortalLinkResult {
  success: boolean
  data?: {
    sentTo: string
    customerName: string
    expiresAt: string
  }
  error?: string
}

/**
 * Generate a single-use portal link AND email it to the customer.
 *
 * Reuses generateCustomerPortalLink for the link mint. Email goes via Resend
 * if RESEND_API_KEY is configured; otherwise we surface a clear error so the
 * admin knows to use Copy URL instead.
 *
 * Gated here as well as inside generateCustomerPortalLink so the send stays
 * locked even if the mint is ever inlined or swapped out.
 */
export async function sendCustomerPortalLink(
  customerId: string
): Promise<SendPortalLinkResult> {
  const gate = await assertPortalManager()
  if (!gate.ok) {
    return { success: false, error: gate.error }
  }

  const linkResult = await generateCustomerPortalLink(customerId)

  if (!linkResult.success || !linkResult.data) {
    return {
      success: false,
      error: linkResult.error ?? 'Could not create the portal link.',
    }
  }

  const {
    customerName,
    customerEmail,
    portalUrl,
    expiresAt,
    organizationName,
  } = linkResult.data

  const sendTo = customerEmail
  if (!sendTo) {
    return {
      success: false,
      error:
        "This customer doesn't have an email on file. Use Copy URL or Open in new tab instead.",
    }
  }

  const apiKey = process.env.RESEND_API_KEY
  // Portal links go to end-customers of the merchant. Replies should
  // NOT land in the operator's inbox, so prefer the noreply sender
  // (RESEND_INVOICE_FROM_EMAIL) and fall back to RESEND_FROM_EMAIL. Mirrors the
  // canonical pattern in invoices.ts.
  const fromAddress =
    process.env.RESEND_INVOICE_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim()

  if (!apiKey) {
    return {
      success: false,
      error:
        'Email is not configured (RESEND_API_KEY missing). Use Copy URL or Open in new tab.',
    }
  }

  if (!fromAddress) {
    return {
      success: false,
      error:
        'Email has no sender address, because neither RESEND_INVOICE_FROM_EMAIL nor RESEND_FROM_EMAIL is set. Set one of them to an address on a domain verified in Resend, or use Copy URL or Open in new tab.',
    }
  }

  try {
    const resend = new Resend(apiKey)

    const subject = 'Your billing portal link'
    const html = renderPortalEmail({
      customerName,
      organizationName,
      portalUrl,
      expiresAtIso: expiresAt,
    })

    const result = await resend.emails.send({
      from: fromAddress,
      to: sendTo,
      subject,
      html,
    })

    if (result.error) {
      console.error('[sendCustomerPortalLink] Resend error:', result.error)
      return {
        success: false,
        error: `Email could not be delivered: ${result.error.message ?? 'unknown error'}.`,
      }
    }

    return {
      success: true,
      data: {
        sentTo: sendTo,
        customerName,
        expiresAt,
      },
    }
  } catch (error) {
    console.error('[sendCustomerPortalLink] Unexpected error:', error)
    return {
      success: false,
      error: 'Could not send the email. Try again or use Copy URL.',
    }
  }
}

function renderPortalEmail({
  customerName,
  organizationName,
  portalUrl,
  expiresAtIso,
}: {
  customerName: string
  organizationName: string
  portalUrl: string
  expiresAtIso: string
}): string {
  const safePortalUrl = escapeHtml(portalUrl)
  const expiresAt = new Date(expiresAtIso)
  const expiresLabel = expiresAt.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })

  const copyright = copyrightLine()
  const footerHtml = copyright
    ? `\n      <hr style="border: 0; border-top: 1px solid #eee; margin: 32px 0 16px;" />\n      <p style="font-size: 11px; color: #aaa; margin: 0;">${escapeHtml(copyright)}</p>`
    : ''

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #111;">
      <h1 style="font-size: 20px; margin: 0 0 16px; color: #003024;">Hi ${escapeHtml(customerName)},</h1>
      <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;">You're receiving this because you have a billing account with <strong>${escapeHtml(organizationName)}</strong>.</p>
      <p style="font-size: 15px; line-height: 1.5; margin: 0 0 24px;">Here's your billing portal link. It opens once and expires at <strong>${escapeHtml(expiresLabel)}</strong>.</p>
      <p style="margin: 0 0 32px;">
        <a href="${safePortalUrl}" style="display: inline-block; background: #003024; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Open my portal</a>
      </p>
      <p style="font-size: 13px; color: #555; line-height: 1.5; margin: 0 0 8px;">If the button doesn't work, paste this URL into your browser:</p>
      <p style="font-size: 12px; color: #888; word-break: break-all; margin: 0 0 32px;">${safePortalUrl}</p>
      <p style="font-size: 12px; color: #999; line-height: 1.5; margin: 0;">If you weren't expecting this email, you can ignore it — the link will expire on its own.</p>${footerHtml}
    </div>
  `
}
