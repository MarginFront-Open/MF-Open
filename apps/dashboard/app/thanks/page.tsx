/**
 * Stripe Checkout success_url destination.
 *
 * Customer just paid via Stripe Checkout. Stripe redirects them here with a
 * `session_id` query param (substituted from `{CHECKOUT_SESSION_ID}` template).
 * They are not logged into the dashboard. Route is in middleware's publicRoutes.
 *
 * Architecture:
 *   1. Look up the invoice_payments row by Stripe checkout session ID. That row
 *      was created at checkout-creation time, so it always exists for a real
 *      Stripe-signed session_id. Tampering with the URL yields a lookup miss
 *      and falls through to the generic "Payment received" page below.
 *   2. Mint a single-use 1-hour MarginFront portal magic link for that row's
 *      customer with `createPortalMagicLink`, the same helper the portal
 *      sign-in and "Send Portal Link" paths use.
 *   3. 302 to /r/<token> on the portal host. The portal redeemer atomically
 *      marks-used, mints a session cookie on the portal domain, and lands the
 *      customer on their org portal view.
 *
 * This page reads ONLY the Stripe-signed session_id and resolves everything
 * else server-side from the DB. Rendering `?org=...&inv=...&amt=...` raw from
 * the URL would let a tampered link show fake values.
 */
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { db as prisma } from '@/app/lib/db'
import { createPortalMagicLink } from '@/app/lib/portal-auth'
import { buildRedeemUrl } from '@/lib/portal-url'

export const metadata: Metadata = {
  title: 'Payment received',
}

type SearchParams = Promise<{ session_id?: string }>

export default async function ThanksPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const params = await searchParams
  const sessionId = params.session_id

  // Resolve a portal redirect URL outside of any try/catch so the
  // Next.js NEXT_REDIRECT throw isn't accidentally swallowed.
  let redirectUrl: string | null = null

  if (sessionId) {
    try {
      const payment = await prisma.invoice_payments.findFirst({
        where: { provider_checkout_session_id: sessionId },
        select: {
          invoices: {
            select: {
              customers: {
                select: { id: true, organizationId: true },
              },
            },
          },
        },
      })

      const customer = payment?.invoices?.customers
      if (customer?.id && customer.organizationId) {
        const token = await createPortalMagicLink(
          customer.id,
          customer.organizationId,
        )
        redirectUrl = buildRedeemUrl(token)
      }
    } catch (err) {
      // Lookup or mint failed. Fall through to generic page rather than
      // leaking a 500. The error goes to the server log.
      console.error('[thanks] portal link mint failed:', err)
    }
  }

  if (redirectUrl) {
    redirect(redirectUrl)
  }

  // Generic fallback. No URL params trusted, no DB-derived data rendered.
  // Customer either tampered with the URL, the session doesn't match any
  // tracked checkout, or the portal mint failed transiently.
  return (
    <main className='flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12'>
      <div className='w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm'>
        <div className='mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100'>
          <svg
            className='h-8 w-8 text-emerald-600'
            fill='none'
            viewBox='0 0 24 24'
            stroke='currentColor'
            strokeWidth={3}
            aria-hidden='true'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              d='M5 13l4 4L19 7'
            />
          </svg>
        </div>

        <h1 className='mb-2 text-2xl font-semibold text-neutral-900'>
          Payment received
        </h1>

        <p className='mb-6 leading-relaxed text-neutral-600'>
          Your payment has been received. The merchant will email you a receipt
          shortly.
        </p>

        <div className='border-t border-neutral-100 pt-6'>
          <p className='text-sm text-neutral-500'>You can close this window.</p>
        </div>
      </div>
    </main>
  )
}
