/**
 * Public "Pay this invoice" redirect handler.
 *
 * What it does for the customer:
 *   They click the "Pay Now" button in an invoice email → land here →
 *   we server-side mint a fresh Stripe Checkout Session → 302 them straight
 *   to Stripe. No interstitial page, no portal, no auth required.
 *
 * Why this lives on the dashboard instead of api-nest directly:
 *   - The customer-facing URL is `app.example.com/i/{id}/pay` — same
 *     trusted domain they already see for the rest of MarginFront's UX.
 *     A bare `api.example.com/...` link in an email feels off.
 *   - The dashboard already has FRONTEND_URL set everywhere; api-nest doesn't
 *     have its own URL env var. This keeps the email-template `paymentUrl`
 *     simple to build on the api-nest side.
 *
 * Why not a Server Action / form POST:
 *   Customers reach this from a plain `<a href>` in an HTML email. The
 *   GET-+-302 flow is the only one that works with that surface — no JS,
 *   no form post.
 *
 * Failure modes:
 *   - Invoice not found (404 from api-nest) → branded "Invoice not found" page.
 *   - Invoice already paid / void (400 from api-nest service.ts) → branded
 *     "This invoice can't be paid" page with the specific reason.
 *   - Stripe $0.50 minimum violation (also 400)
 *     → same branded error page with the specific reason.
 *   - Anything else (network, unhandled) → branded "Something went wrong"
 *     page with the api-nest message bubbled up for debuggability.
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Same brand palette used in invoice emails (api-nest email.service.ts), so the
// error page doesn't look like it dropped in from a different product.
const BRAND_DARK = '#003024'
const BRAND_ACCENT = '#00ff88'

function errorPage(opts: {
  status: number
  title: string
  message: string
  detail?: string
}): Response {
  const { status, title, message, detail } = opts
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | MarginFront</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px;">
    <div style="background:linear-gradient(135deg,${BRAND_DARK} 0%,#004d3d 100%);padding:30px;border-radius:12px 12px 0 0;text-align:center;">
      <h1 style="color:${BRAND_ACCENT};margin:0;font-size:24px;font-weight:600;">${title}</h1>
    </div>
    <div style="background-color:#ffffff;padding:30px;border-radius:0 0 12px 12px;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
      <p style="color:#333;font-size:16px;margin:0 0 16px 0;line-height:1.6;">${message}</p>
      ${detail ? `<p style="color:#666;font-size:14px;margin:0 0 16px 0;line-height:1.6;padding:12px;background:#fafafa;border-radius:6px;">${detail}</p>` : ''}
      <p style="color:#666;font-size:14px;margin:24px 0 0 0;line-height:1.6;">
        If you think this is a mistake, contact the business that sent you this invoice. They can fix the issue and resend the link.
      </p>
    </div>
  </div>
</body>
</html>`
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  const { invoiceId } = await params

  if (!invoiceId || invoiceId.trim() === '') {
    return errorPage({
      status: 400,
      title: 'Invalid invoice link',
      message:
        "This payment link is missing an invoice ID, so we can't open a checkout.",
    })
  }

  // NEXT_PUBLIC_API_BASE_URL ends with `/v1` (e.g. http://localhost:4000/v1 or
  // https://api.example.com/v1). The public-invoice controller is mounted
  // at `public/invoices`, so the full path is `{base}/public/invoices/{id}/checkout`.
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL
  if (!apiBase) {
    console.error('[/i/[id]/pay] NEXT_PUBLIC_API_BASE_URL is not set')
    return errorPage({
      status: 500,
      title: 'Service unavailable',
      message:
        'The payment system is temporarily unavailable. Try again in a few minutes.',
    })
  }

  try {
    const apiRes = await fetch(
      `${apiBase}/public/invoices/${invoiceId}/checkout`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Empty body: api-nest falls back to its own default successUrl/cancelUrl
        // Stripe sends the customer there after payment.
        body: JSON.stringify({}),
      }
    )

    if (!apiRes.ok) {
      // Try to surface the api-nest error message so the customer (and whoever
      // is debugging) sees the actual reason instead of a generic "failed."
      let detail: string | undefined
      try {
        const body = (await apiRes.json()) as { message?: string | string[] }
        detail = Array.isArray(body?.message)
          ? body.message.join(' ')
          : (body?.message ?? undefined)
      } catch {
        // body wasn't JSON — that's fine, we just won't have a detail string.
      }

      if (apiRes.status === 404) {
        return errorPage({
          status: 404,
          title: 'Invoice not found',
          message:
            "We couldn't find this invoice. The link might be expired, or the invoice might have been deleted.",
          detail,
        })
      }

      if (apiRes.status === 400) {
        return errorPage({
          status: 400,
          title: "This invoice can't be paid right now",
          message:
            "Stripe couldn't accept this payment. The most common reason is that the invoice is already paid, is voided, or the amount is below the payment processor's minimum.",
          detail,
        })
      }

      return errorPage({
        status: 502,
        title: 'Something went wrong',
        message:
          'We hit an unexpected error trying to open the checkout. Please try the link again in a minute.',
        detail,
      })
    }

    const data = (await apiRes.json()) as {
      success: boolean
      session?: { url?: string }
    }
    const stripeUrl = data?.session?.url

    if (!stripeUrl) {
      return errorPage({
        status: 502,
        title: 'Checkout unavailable',
        message:
          "The payment processor didn't return a valid checkout link. Please try again, or contact the business that sent you this invoice.",
      })
    }

    return NextResponse.redirect(stripeUrl, { status: 302 })
  } catch (err) {
    console.error('[/i/[id]/pay] checkout fetch failed:', err)
    return errorPage({
      status: 502,
      title: 'Service unavailable',
      message:
        'We could not reach the payment processor. Try the link again in a few minutes, or contact the business that sent you this invoice.',
      detail: err instanceof Error ? err.message : undefined,
    })
  }
}
