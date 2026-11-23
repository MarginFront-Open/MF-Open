// @ts-nocheck
'use server'
// TypeScript checking is off: some queries here use field names that differ
// from the generated Prisma types.

/**
 * Onboarding Server Actions
 * Server-side actions for onboarding entity creation
 *
 * Note: AI/scraping operations (screenshot, enhancedPreview, extractWebsite)
 * should stay in NestJS API because they require:
 * - Puppeteer for screenshots
 * - OpenAI API for analysis
 * - Complex web scraping
 */

import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { db, Prisma } from '@/app/lib/db'
import { API_BASE_URL } from '@/lib/api/config'
// CreateFromEnhancedPreview writes invoices, subscriptions,
// pricing_plans and pricing_strategies — the books — into the caller's active org.
// A logged-in check alone would let a plain member call it directly, so it's
// gated on the same owner/admin/finance set as the rest of the money writes. (The org's creator is its owner, so legitimate onboarding still passes.)
import { assertMoneyManager } from './_shared/assert-money-manager'
// UpdateOnboardingStatus writes org-administration fields —
// onboarding state, the company logo, brand colors — so it's gated owner/admin only
// (NOT the money set; this writes no numbers). The org's creator is its owner, so a
// legitimate first-time onboarder still passes the gate and can finish.
import { assertOrgManager } from './_shared/assert-org-manager'
import { buildWelcomeEmailHtml } from './_shared/welcome-email'
import { isSafePublicHttpsUrl } from '@/app/lib/public-https-url'
// `user_organizations` and `team_members` are projections of the
// canonical `ba_member` table and may only be written as a pair, through the helpers
// in packages/db/src/lib/membership.ts. Writing either directly is the drift this
// code exists to prevent.
import { setDefaultOrganization } from '@marginfront/db'

// Types for Enhanced Preview (matching frontend types)
export interface EnhancedPricingTier {
  id: string
  enabled: boolean
  name: string
  price: number
  billingCycle: string
  setupFee?: number
  features: string[]
  usageLimits?: Record<string, number | null>
  overageRates?: Record<string, number>
  isPopular?: boolean
  isEnterprise?: boolean
}

export interface EnhancedSignal {
  id: string
  enabled: boolean
  name: string
  shortName: string
  type: 'usage' | 'volume'
  description?: string
}

export interface EnhancedServiceCost {
  id: string
  enabled: boolean
  serviceName: string
  provider: string
  unitType: string
  costPerUnit: number
}

export interface EnhancedCustomer {
  id: string
  enabled: boolean
  name: string
  email: string
  phone?: string
  industry?: string
  employeeCount?: number
  region?: string
  city?: string
  state?: string
  country?: string
  zipCode?: string
  addressLine1?: string
  timezone?: string
  contactName?: string
  contactTitle?: string
  assignedPlan: string
  subscriptionStartDaysAgo?: number
  tags?: string[]
  notes?: string
}

export interface EnhancedPreviewData {
  success: boolean
  websiteUrl: string
  pricingPageUrl?: string | null
  companyInfo: {
    name: string
    description?: string
    logo?: string
    website?: string
  }
  companyContext?: {
    shortSummary: string
    longContext: string
  }
  pricingData: {
    tiers: EnhancedPricingTier[]
    signals: EnhancedSignal[]
    serviceCosts: EnhancedServiceCost[]
  }
  customers: EnhancedCustomer[]
  summary: {
    pricingTiersCount: number
    signalsCount: number
    serviceCostsCount: number
    customersCount: number
  }
}

export interface CreatedResources {
  agent?: { id: string; name: string }
  signals?: Array<{ id: string; name: string; shortName?: string }>
  pricingPlans?: Array<{ id: string; name: string }>
  serviceCosts?: Array<{ id: string; serviceName: string }>
  customers?: Array<{ id: string; externalId: string; name: string }>
  subscriptions?: Array<{ id: string }>
}

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/**
 * Create all resources from enhanced preview data
 * This is the main onboarding entity creation action
 */
export async function createFromEnhancedPreview(
  previewData: EnhancedPreviewData
): Promise<ActionResult<{ created: CreatedResources }>> {
  try {
    // Role gate FIRST: only owner/admin/finance may seed the books. Checks the
    // caller's role in their active org and hands back the org id we write to.
    const gate = await assertMoneyManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    const orgId = gate.orgId
    const _userId = gate.userId

    const created: CreatedResources = {}

    // Wrap core entity creation in a transaction to prevent orphaned data
    const {
      agentId,
      createdSignals,
      createdPlans,
      createdCustomers,
      createdSubscriptions,
      enabledCustomers: txEnabledCustomers,
    } = await db.$transaction(
      async (tx) => {
        // 1. Create Agent
        const agentId = crypto.randomUUID()
        const agentCode = previewData.companyInfo.name
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-')
          .substring(0, 50)

        const _agent = await tx.agents.create({
          data: {
            id: agentId,
            orgId: orgId,
            name: previewData.companyInfo.name,
            agentCode,
            description:
              previewData.companyInfo.description ||
              `${previewData.companyInfo.name} agent`,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        })

        // created.agent set after transaction

        // 2. Create Signals (only enabled ones with valid names)
        const enabledSignals = previewData.pricingData.signals.filter(
          (s) => s.enabled && s.name
        )
        const createdSignals: Array<{
          id: string
          name: string
          shortName?: string
        }> = []

        for (const signal of enabledSignals) {
          // Skip signals without valid name (defensive check)
          if (!signal.name || typeof signal.name !== 'string') {
            console.warn(
              '[createFromEnhancedPreview] Skipping signal with invalid name:',
              signal
            )
            continue
          }

          const signalId = crypto.randomUUID()
          const createdSignal = await tx.signals.create({
            data: {
              id: signalId,
              orgId: orgId,
              agentId: agentId,
              name: signal.name.slice(0, 255),
              shortName: signal.shortName?.slice(0, 255),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          })
          createdSignals.push({
            id: createdSignal.id,
            name: createdSignal.name,
            shortName: createdSignal.shortName || undefined,
          })
        }
        // created.signals set after transaction

        // 3. Create Pricing Plans and Strategies (only enabled tiers with valid names)
        const enabledTiers = previewData.pricingData.tiers.filter(
          (t) => t.enabled && t.name
        )
        const createdPlans: Array<{ id: string; name: string }> = []

        for (const tier of enabledTiers) {
          // Skip tiers without valid name (defensive check)
          if (!tier.name || typeof tier.name !== 'string') {
            console.warn(
              '[createFromEnhancedPreview] Skipping tier with invalid name:',
              tier
            )
            continue
          }

          const planId = crypto.randomUUID()
          // Truncate description to fit within 255 char limit
          const features = Array.isArray(tier.features) ? tier.features : []
          const fullDescription = features.join(', ')
          const description =
            fullDescription.length > 250
              ? fullDescription.slice(0, 247) + '...'
              : fullDescription

          const plan = await tx.pricing_plans.create({
            data: {
              id: planId,
              orgId: orgId,
              agentId: agentId,
              name: tier.name.slice(0, 255), // Ensure name also fits
              description,
              featuresList: features,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          })

          // Create pricing strategies for each signal in this tier
          for (const signal of createdSignals) {
            const strategyId = crypto.randomUUID()
            await tx.pricing_strategies.create({
              data: {
                id: strategyId,
                orgId: orgId,
                agentId: agentId,
                planId: planId,
                signalId: signal.id,
                name: `${tier.name} - ${signal.name}`.slice(0, 255),
                chargeType: 'recurring',
                billingFrequency:
                  tier.billingCycle === 'yearly' ? 'yearly' : 'monthly',
                pricingModel: 'flat',
                rate: new Prisma.Decimal(tier.price ?? 0),
                active: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            })
          }

          createdPlans.push({ id: plan.id, name: plan.name })
        }
        // created.pricingPlans set after transaction

        // 4. Create Service Costs (only enabled ones)
        const enabledServiceCosts = previewData.pricingData.serviceCosts.filter(
          (sc) => sc.enabled
        )
        const createdServiceCosts: Array<{ id: string; serviceName: string }> =
          []

        for (const serviceCost of enabledServiceCosts) {
          const serviceCostId = crypto.randomUUID()
          const createdCost = await tx.service_costs.create({
            data: {
              id: serviceCostId,
              organizationId: orgId,
              agentId: agentId,
              serviceName: serviceCost.serviceName.slice(0, 255),
              provider: serviceCost.provider?.slice(0, 255),
              unitType: serviceCost.unitType.slice(0, 255),
              costPerUnit: new Prisma.Decimal(serviceCost.costPerUnit),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          })
          createdServiceCosts.push({
            id: createdCost.id,
            serviceName: createdCost.serviceName,
          })
        }
        // created.serviceCosts set after transaction

        // 5. Create Customers (only enabled ones)
        const enabledCustomers = previewData.customers.filter((c) => c.enabled)
        const createdCustomers: Array<{
          id: string
          externalId: string
          name: string
        }> = []
        const createdSubscriptions: Array<{ id: string; startDate: Date }> = []

        let customerIndex = 0
        for (const customer of enabledCustomers) {
          const customerId = crypto.randomUUID()
          const externalId = `customer-${crypto.randomUUID().substring(0, 8)}`

          const createdCustomer = await tx.customers.create({
            data: {
              id: customerId,
              organizationId: orgId,
              externalId,
              name: customer.name.slice(0, 255),
              email: customer.email?.slice(0, 255),
              phone: customer.phone || null,
              city: customer.city || null,
              state: customer.state || null,
              country: customer.country || null,
              zipCode: customer.zipCode || null,
              addressLine1: customer.addressLine1 || null,
              timezone: customer.timezone || 'UTC',
              billingContactName: customer.contactName || null,
              status: 'active',
              metadata: {
                industry: customer.industry || null,
                employeeCount: customer.employeeCount || null,
                region: customer.region || null,
                contactTitle: customer.contactTitle || null,
                tags: customer.tags || [],
                notes: customer.notes || null,
              },
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          })

          createdCustomers.push({
            id: createdCustomer.id,
            externalId: createdCustomer.externalId,
            name: createdCustomer.name,
          })

          // Create subscription for customer if we have a matching plan
          const matchingPlan =
            createdPlans.find(
              (p) =>
                p.name
                  .toLowerCase()
                  .includes(customer.assignedPlan.toLowerCase()) ||
                customer.assignedPlan
                  .toLowerCase()
                  .includes(p.name.toLowerCase())
            ) || createdPlans[0]

          if (matchingPlan) {
            const subscriptionId = crypto.randomUUID()
            const startDate = new Date()
            // Stagger subscription start dates for realism (30-120 days ago)
            const daysAgo =
              customer.subscriptionStartDaysAgo ||
              30 +
                Math.floor(customerIndex * 25) +
                Math.floor(Math.random() * 15)
            startDate.setDate(startDate.getDate() - daysAgo)

            // Calculate current billing period by rolling forward from start date
            const billingPeriodStart = new Date(startDate)
            const nowForBilling = new Date()
            while (true) {
              const nextPeriod = new Date(billingPeriodStart)
              nextPeriod.setMonth(nextPeriod.getMonth() + 1)
              if (nextPeriod > nowForBilling) break
              billingPeriodStart.setMonth(billingPeriodStart.getMonth() + 1)
            }
            const billingPeriodEnd = new Date(billingPeriodStart)
            billingPeriodEnd.setMonth(billingPeriodEnd.getMonth() + 1)

            const subscription = await tx.subscriptions.create({
              data: {
                id: subscriptionId,
                organizationId: orgId,
                customerId: customerId,
                planId: matchingPlan.id,
                agentId: agentId,
                name: `${customer.name} - ${matchingPlan.name}`,
                status: 'active',
                startDate,
                billingCycle: 'monthly',
                billingModel: 'usage',
                currentBillingPeriodStart: billingPeriodStart,
                currentBillingPeriodEnd: billingPeriodEnd,
                nextRecurringInvoiceAt: billingPeriodEnd,
                nextUsageInvoiceAt: billingPeriodEnd,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            })

            createdSubscriptions.push({ id: subscription.id, startDate })
          }
          customerIndex++
        }

        return {
          agentId,
          createdSignals,
          createdPlans,
          createdCustomers,
          createdSubscriptions,
          enabledCustomers,
        }
      },
      { timeout: 30000 }
    ) // 30s timeout for transaction

    created.agent = { id: agentId, name: previewData.companyInfo.name }
    created.signals = createdSignals
    created.pricingPlans = createdPlans
    created.customers = createdCustomers
    created.subscriptions = createdSubscriptions
    const enabledCustomers = txEnabledCustomers

    // 6. Create sample usage data and invoices for each customer
    // This populates developer zone previews (UsageDashboard, InvoiceViewer, etc.)
    let invoiceCounter = 1
    for (let i = 0; i < createdCustomers.length; i++) {
      const customer = createdCustomers[i]
      const subscription = createdSubscriptions[i]
      if (!customer || !subscription) continue

      const matchingPlan = createdPlans[i % createdPlans.length]
      const _enabledCustomer = enabledCustomers[i]

      try {
        const now = new Date()
        const thirtyDaysAgo = new Date(now)
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

        // Tier-based scaling: higher tier plans = more usage
        const planIndex = createdPlans.findIndex(
          (p) => p.id === matchingPlan?.id
        )
        const tierMultiplier = Math.max(1, planIndex + 1) // 1x, 2x, 3x, 4x

        // Generate more events for higher tiers, use all signals
        const eventCount =
          (50 + Math.floor(Math.random() * 51)) * tierMultiplier
        for (let e = 0; e < eventCount; e++) {
          const dayOffset = Math.floor(Math.random() * 30)
          const eventDate = new Date(thirtyDaysAgo)
          eventDate.setDate(eventDate.getDate() + dayOffset)

          // Weighted hour distribution: 70% business hours, 20% shoulder, 10% off-hours
          const hourRoll = Math.random()
          let hour: number
          if (hourRoll < 0.7) {
            hour = 9 + Math.floor(Math.random() * 8) // 9-16 (business)
          } else if (hourRoll < 0.9) {
            hour =
              Math.random() < 0.5
                ? 7 + Math.floor(Math.random() * 2)
                : 17 + Math.floor(Math.random() * 4) // 7-8 or 17-20
          } else {
            hour = (21 + Math.floor(Math.random() * 10)) % 24 // 21-6 (off-hours)
          }
          eventDate.setHours(
            hour,
            Math.floor(Math.random() * 60),
            Math.floor(Math.random() * 60)
          )

          // Scale quantities by tier for realistic usage volumes
          const baseQuantity = 20 + Math.floor(Math.random() * 80)
          const quantity = baseQuantity * tierMultiplier
          const rawId = crypto.randomUUID()
          const eventId = crypto.randomUUID()
          const signal =
            createdSignals.length > 0
              ? createdSignals[e % createdSignals.length]
              : null

          await db.raw_ingest_events.create({
            data: {
              id: rawId,
              organizationId: orgId,
              payload: {
                signalName: signal?.shortName || 'usage',
                customerId: customer.externalId,
                quantity,
              },
              status: 'PROCESSED',
              receivedAt: eventDate,
              processedAt: eventDate,
              eventId,
              createdAt: eventDate,
              updatedAt: eventDate,
            },
          })

          await db.signal_events.create({
            data: {
              id: eventId,
              customerExternalId: customer.externalId,
              customerId: customer.id,
              subscriptionId: subscription.id,
              organizationId: orgId,
              agentId: agentId,
              signalId: signal?.id || null,
              rawIngestEventId: rawId,
              usageDate: eventDate,
              quantity,
              usageCost: quantity * 0.03,
              usageCostData: { rate: 0.03, quantity, total: quantity * 0.03 },
              eventProcessed: 'PROCESSED',
              eventProcessedAt: eventDate,
              createdAt: eventDate,
              updatedAt: eventDate,
            },
          })
        }

        // Compute billing periods aligned to subscription start date
        const subStartDate = new Date(subscription.startDate)
        // Find the current billing period start (most recent anniversary before now)
        const curBillingStart = new Date(subStartDate)
        while (true) {
          const nextPeriod = new Date(curBillingStart)
          nextPeriod.setMonth(nextPeriod.getMonth() + 1)
          if (nextPeriod > now) break
          curBillingStart.setMonth(curBillingStart.getMonth() + 1)
        }
        const curBillingEnd = new Date(curBillingStart)
        curBillingEnd.setMonth(curBillingEnd.getMonth() + 1)
        // Previous billing period = one month before current
        const prevBillingStart = new Date(curBillingStart)
        prevBillingStart.setMonth(prevBillingStart.getMonth() - 1)
        const prevBillingEnd = new Date(curBillingStart)

        // Get tier price from the preview data pricing tiers (prefer paid tiers over free ones)
        const enabledTiers = previewData.pricingData.tiers.filter(
          (t) => t.enabled
        )
        const paidTiers = enabledTiers.filter((t) => (t.price ?? 0) > 0)
        const tierPool = paidTiers.length > 0 ? paidTiers : enabledTiers
        const tierData = tierPool[i % tierPool.length]
        const tierPrice = tierData?.price ?? 49.99

        // Create 1 paid invoice for the previous billing period
        const invoiceId = crypto.randomUUID()
        const invNum = `INV-${invoiceCounter.toString().padStart(5, '0')}`
        invoiceCounter++
        const invoiceDate = prevBillingEnd
        const dueDate = new Date(invoiceDate)
        dueDate.setDate(dueDate.getDate() + 30)

        await db.invoices.create({
          data: {
            id: invoiceId,
            customerId: customer.id,
            subscriptionId: subscription.id,
            organizationId: orgId,
            invoiceDate,
            dueDate,
            billingPeriodStart: prevBillingStart,
            billingPeriodEnd: prevBillingEnd,
            invoiceType: 'subscription',
            totalAmount: tierPrice,
            subtotal: tierPrice,
            taxAmount: 0,
            discountAmount: 0,
            status: 'paid',
            invoiceNumber: invNum,
            currency: 'USD',
            netTerms: 30,
            amountPaid: tierPrice,
            amountCredited: 0,
            amountDue: 0,
            isFinalizedUsage: true,
            invoiceGenerationType: 'automatic',
            memo: `${matchingPlan?.name || 'Plan'} - Monthly`,
            createdAt: prevBillingStart,
            updatedAt: invoiceDate,
          },
        })

        await db.invoice_line_items.create({
          data: {
            id: crypto.randomUUID(),
            invoiceId,
            description: `${matchingPlan?.name || 'Plan'} - Monthly Subscription`,
            quantity: 1,
            unitPrice: tierPrice,
            amount: tierPrice,
            type: 'recurring',
            createdAt: prevBillingStart,
            updatedAt: invoiceDate,
          },
        })

        // Create payment record for the paid invoice
        await db.invoice_payments.create({
          data: {
            id: crypto.randomUUID(),
            invoiceId,
            amount: tierPrice,
            paymentDate: invoiceDate,
            paymentMethod: 'stripe',
            reference: `pi_sample_${crypto.randomUUID().substring(0, 12)}`,
            notes: 'Sample payment',
            currency: 'USD',
            status: 'succeeded',
            card_last4: ['4242', '5555', '1234', '8888'][i % 4],
            card_brand: ['visa', 'mastercard', 'visa', 'amex'][i % 4],
            createdAt: invoiceDate,
            updatedAt: invoiceDate,
          },
        })

        // Create 1 pending invoice for current billing period
        const curInvoiceId = crypto.randomUUID()
        const curInvNum = `INV-${invoiceCounter.toString().padStart(5, '0')}`
        invoiceCounter++
        const curDueDate = new Date(curBillingEnd)
        curDueDate.setDate(curDueDate.getDate() + 30)

        await db.invoices.create({
          data: {
            id: curInvoiceId,
            customerId: customer.id,
            subscriptionId: subscription.id,
            organizationId: orgId,
            invoiceDate: now,
            dueDate: curDueDate,
            billingPeriodStart: curBillingStart,
            billingPeriodEnd: curBillingEnd,
            invoiceType: 'subscription',
            totalAmount: tierPrice,
            subtotal: tierPrice,
            taxAmount: 0,
            discountAmount: 0,
            status: 'issued',
            invoiceNumber: curInvNum,
            currency: 'USD',
            netTerms: 30,
            amountPaid: 0,
            amountCredited: 0,
            amountDue: tierPrice,
            isFinalizedUsage: false,
            invoiceGenerationType: 'automatic',
            memo: `${matchingPlan?.name || 'Plan'} - Monthly`,
            createdAt: curBillingStart,
            updatedAt: now,
          },
        })

        await db.invoice_line_items.create({
          data: {
            id: crypto.randomUUID(),
            invoiceId: curInvoiceId,
            description: `${matchingPlan?.name || 'Plan'} - Monthly Subscription`,
            quantity: 1,
            unitPrice: tierPrice,
            amount: tierPrice,
            type: 'recurring',
            createdAt: curBillingStart,
            updatedAt: now,
          },
        })

        console.log(
          `[createFromEnhancedPreview] Created sample data for ${customer.name}: ${eventCount} events, 2 invoices, 1 payment`
        )
      } catch (sampleDataError) {
        // Don't fail onboarding if sample data creation fails
        console.error(
          `[createFromEnhancedPreview] Failed to create sample data for ${customer.name}:`,
          sampleDataError
        )
      }
    }

    // Update organization with logo and website from preview data
    console.log(
      '[createFromEnhancedPreview] Logo from preview:',
      previewData.companyInfo?.logo
    )
    console.log(
      '[createFromEnhancedPreview] Website from preview:',
      previewData.companyInfo?.website
    )
    console.log('[createFromEnhancedPreview] Org ID:', orgId)

    const safeLogo =
      previewData.companyInfo?.logo &&
      isSafePublicHttpsUrl(previewData.companyInfo.logo)
        ? previewData.companyInfo.logo
        : undefined

    if (safeLogo || previewData.companyInfo?.website) {
      console.log('[createFromEnhancedPreview] Updating org with logo/website')
      await db.organizations.update({
        where: { id: orgId },
        data: {
          ...(safeLogo && {
            logo: safeLogo,
          }),
          ...(previewData.companyInfo.website && {
            website: previewData.companyInfo.website,
          }),
          updatedAt: new Date(),
        },
      })
      console.log('[createFromEnhancedPreview] Org updated successfully')
    } else {
      console.log('[createFromEnhancedPreview] No logo or website to update')
    }

    return { success: true, data: { created } }
  } catch (error) {
    console.error('Error in createFromEnhancedPreview:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create resources from preview',
    }
  }
}

// Branding data type for saving to database
export interface BrandingDataInput {
  primaryColor?: string
  secondaryColor?: string
  accentColor?: string
  companyLogo?: string
  portalSlug?: string
}

// -- Send welcome email via Resend --
// Called after first-time onboarding completion. Errors are logged but never
// bubble up to the caller, because a failed email should not break onboarding.
async function sendWelcomeEmail(email: string): Promise<void> {
  try {
    const apiKey = process.env.RESEND_API_KEY?.trim()
    const fromEmail = process.env.RESEND_FROM_EMAIL?.trim()

    if (!apiKey || !fromEmail) {
      console.error(
        '[Onboarding] RESEND_API_KEY or RESEND_FROM_EMAIL not configured, skipping welcome email'
      )
      return
    }

    console.log('[Onboarding] Sending welcome email to:', email)

    const { Resend } = await import('resend')
    const resend = new Resend(apiKey)

    const { error } = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: 'Welcome to MarginFront',
      html: buildWelcomeEmailHtml(),
    })

    if (error) {
      console.error('[Onboarding] Resend error:', error)
      return
    }

    console.log('[Onboarding] Welcome email sent successfully')
  } catch (err) {
    console.error('[Onboarding] Failed to send welcome email:', err)
  }
}

/**
 * Update organization's onboarding status
 */
export async function updateOnboardingStatus(params: {
  onboardingComplete?: boolean
  onboardingStep?: string | null
  branding?: BrandingDataInput
}): Promise<ActionResult<{ message: string }>> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId || !session?.user?.id) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    // Role gate: completing onboarding writes org-administration
    // fields (onboarding state, logo, brand colors), so only an owner/admin may do it.
    // The org's creator gets an 'owner' ba_member row when the org is created (Better
    // Auth), so a first-time onboarder passes. This is checked in the caller's
    // active org, the same org the writes below target.
    // A plain member who somehow reaches this action is rejected before any write.
    const gate = await assertOrgManager()
    if (!gate.ok) {
      return { success: false, error: gate.error }
    }

    if (
      params.branding?.companyLogo !== undefined &&
      params.branding.companyLogo !== '' &&
      !isSafePublicHttpsUrl(params.branding.companyLogo)
    ) {
      return {
        success: false,
        error:
          'Logo URL was rejected because it must be a public https:// address. Provide an https:// URL hosted on a public domain or clear the logo field.',
      }
    }

    // Check if onboarding was already complete BEFORE we update it.
    // Used later to prevent duplicate welcome emails on repeat submissions.
    let wasAlreadyComplete = false
    if (params.onboardingComplete === true) {
      const orgStatus = await db.organizations.findUnique({
        where: { id: orgId },
        select: { onboarding_complete: true },
      })
      wasAlreadyComplete = orgStatus?.onboarding_complete ?? false
    }

    // If branding is provided, merge it into the existing designjson
    let designJsonUpdate = undefined
    if (params.branding) {
      // Fetch current designjson to merge with new branding
      const currentOrg = await db.organizations.findUnique({
        where: { id: orgId },
        select: { designjson: true },
      })

      const currentDesignJson =
        (currentOrg?.designjson as Record<string, unknown>) || {}

      designJsonUpdate = {
        ...currentDesignJson,
        ...(params.branding.primaryColor && {
          primaryColor: params.branding.primaryColor,
        }),
        ...(params.branding.secondaryColor && {
          secondaryColor: params.branding.secondaryColor,
        }),
        ...(params.branding.accentColor && {
          accentColor: params.branding.accentColor,
        }),
      }

      console.log('[updateOnboardingStatus] Saving branding to designjson:', {
        primaryColor: params.branding.primaryColor,
        secondaryColor: params.branding.secondaryColor,
        accentColor: params.branding.accentColor,
      })
    }

    await db.organizations.update({
      where: { id: orgId },
      data: {
        ...(params.onboardingComplete !== undefined && {
          onboarding_complete: params.onboardingComplete,
        }),
        ...(params.onboardingStep !== undefined && {
          onboarding_step: params.onboardingStep,
        }),
        ...(designJsonUpdate && { designjson: designJsonUpdate }),
        ...(params.branding?.companyLogo && {
          logo: params.branding.companyLogo,
        }),
        updatedAt: new Date(),
      },
    })

    // Fix up user/org data and create admin test customer when onboarding completes
    if (params.onboardingComplete === true) {
      try {
        // Fetch admin user details
        const adminUser = await db.users.findUnique({
          where: { id: userId },
          select: { email: true, name: true },
        })

        // Populate user name if empty (magic link / social auth don't collect name)
        if (adminUser && (!adminUser.name || adminUser.name.trim() === '')) {
          const derivedName = adminUser.email
            .split('@')[0]
            .replace(/[._-]/g, ' ')
            .replace(/\b\w/g, (c: string) => c.toUpperCase())
          await db.users.update({
            where: { id: userId },
            data: { name: derivedName, updatedAt: new Date() },
          })
          adminUser.name = derivedName
          console.log(`[Onboarding] Set user name from email: ${derivedName}`)
        }

        // Set org owner_id if null (Better Auth doesn't set it)
        const currentOrg = await db.organizations.findUnique({
          where: { id: orgId },
          select: { owner_id: true },
        })
        if (currentOrg && !currentOrg.owner_id) {
          await db.organizations.update({
            where: { id: orgId },
            data: { owner_id: userId, updatedAt: new Date() },
          })
          console.log(`[Onboarding] Set org owner_id: ${userId}`)
        }

        // Back-fill the projection rows, and stamp this org as the user's
        // default. Better Auth owns `ba_member` and mints the creator's row inside
        // node_modules; our afterAddMember hook projects it, but no hook can set
        // `isDefault`, because that flag is one-per-USER and setting it means clearing
        // it on every other org in the same breath.
        //
        // setDefaultOrganization, NOT writeMembershipProjections: the projection rows
        // already exist by the time onboarding finishes (the hook wrote them at org
        // creation), and the create-if-absent helper would find them and do nothing —
        // leaving every new signup with NO default org at all. It creates what is
        // missing, then clears and sets the flag, all in one transaction.
        try {
          const canonicalMembership = await db.ba_member.findFirst({
            where: { organizationId: orgId, userId },
            select: { role: true },
          })
          await setDefaultOrganization(db, {
            organizationId: orgId,
            userId,
            // 'member', not 'owner': assertOrgManager admits admins too, and a
            // projection that invents ownership is the one wrong answer that could
            // matter if anything ever reads this column.
            role: canonicalMembership?.role ?? 'member',
          })
        } catch (projectionError) {
          console.error(
            `[Onboarding] MEMBERSHIP_PROJECTION_DRIFT could not mark org ${orgId} as the default ` +
              `organization for user ${userId}. Setup is complete and access is correct, ` +
              `because permission checks read ba_member. If another organization opens first ` +
              `when this user signs in, they can switch to this one from the organization menu.`,
            projectionError
          )
        }
        // The welcome email is first-time-only: "first-time" means this user has
        // never completed onboarding for ANY org before.
        if (!wasAlreadyComplete) {
          const hasOtherCompletedOrg = await db.user_organizations.findFirst({
            where: {
              userId,
              organizationId: { not: orgId },
              organizations: { onboarding_complete: true },
            },
            select: { id: true },
          })

          const userEmail = adminUser?.email || session.user.email

          if (hasOtherCompletedOrg) {
            console.log(
              `[Onboarding] Additional org for ${userId}: welcome email skipped (already onboarded elsewhere)`
            )
          } else if (userEmail) {
            await sendWelcomeEmail(userEmail)
          } else {
            console.error(
              `[Onboarding] No email on file for ${userId}: welcome email impossible`
            )
          }
        }
      } catch (fixupError) {
        // Log but don't fail onboarding if fixups fail
        console.error(
          '[Onboarding] Failed during onboarding fixups:',
          fixupError
        )
      }
    }

    return { success: true, data: { message: 'Onboarding status updated' } }
  } catch (error) {
    console.error('Error in updateOnboardingStatus:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to update onboarding status',
    }
  }
}

/**
 * Mark onboarding as complete for the current organization
 * Optionally saves branding data (colors, logo) to the organization
 */
export async function markOnboardingComplete(
  branding?: BrandingDataInput
): Promise<ActionResult<{ message: string }>> {
  return updateOnboardingStatus({
    onboardingComplete: true,
    onboardingStep: null,
    branding,
  })
}

/**
 * Get current onboarding status for the active organization
 */
export async function getOnboardingStatus(): Promise<
  ActionResult<{ onboardingComplete: boolean; onboardingStep: string | null }>
> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    const org = await db.organizations.findUnique({
      where: { id: orgId },
      select: {
        onboarding_complete: true,
        onboarding_step: true,
      },
    })

    if (!org) {
      return { success: false, error: 'Organization not found' }
    }

    return {
      success: true,
      data: {
        onboardingComplete: org.onboarding_complete ?? false,
        onboardingStep: org.onboarding_step,
      },
    }
  } catch (error) {
    console.error('Error in getOnboardingStatus:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to get onboarding status',
    }
  }
}

// ===========================================================================
// API PROXY SERVER ACTIONS
// These proxy to NestJS API for operations requiring Puppeteer/AI
// Server Actions have access to user cookies, solving the cross-origin auth issue
// ===========================================================================

/**
 * Proxy: Get screenshot from NestJS API
 * Requires Puppeteer which runs in NestJS
 */
export async function getScreenshotProxy(
  websiteUrl: string
): Promise<ActionResult<{ screenshotUrl: string | null }>> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // Get cookies from the request to forward to API
    const cookieHeader = headersList.get('cookie') || ''

    const response = await fetch(`${API_BASE_URL}/onboarding/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ websiteUrl }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error(
        '[getScreenshotProxy] API error:',
        response.status,
        errorData
      )
      return {
        success: false,
        error: errorData.message || `API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return {
      success: true,
      data: { screenshotUrl: data.screenshotUrl || null },
    }
  } catch (error) {
    console.error('[getScreenshotProxy] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to get screenshot',
    }
  }
}

/**
 * Proxy: Enhanced preview from NestJS API
 * Requires web scraping + AI analysis which runs in NestJS
 */
export async function enhancedPreviewProxy(
  websiteUrl: string,
  customerCount = 4
): Promise<ActionResult<EnhancedPreviewData>> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // Get cookies from the request to forward to API
    const cookieHeader = headersList.get('cookie') || ''

    const response = await fetch(
      `${API_BASE_URL}/onboarding/enhanced-preview`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ websiteUrl, customerCount }),
        // Extended timeout for AI analysis (bounded by the host's function timeout)
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error(
        '[enhancedPreviewProxy] API error:',
        response.status,
        errorData
      )
      return {
        success: false,
        error: errorData.message || `API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    console.error('[enhancedPreviewProxy] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to generate preview',
    }
  }
}

/**
 * Proxy: Extract company data from NestJS API
 * Requires web scraping + AI which runs in NestJS
 */
export async function extractWebsiteProxy(
  websiteUrl: string
): Promise<
  ActionResult<{ name: string; description?: string; logo?: string }>
> {
  try {
    const headersList = await headers()
    const session = await auth.api.getSession({ headers: headersList })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // Get cookies from the request to forward to API
    const cookieHeader = headersList.get('cookie') || ''

    const response = await fetch(`${API_BASE_URL}/onboarding/extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ websiteUrl }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error(
        '[extractWebsiteProxy] API error:',
        response.status,
        errorData
      )
      return {
        success: false,
        error: errorData.message || `API error: ${response.status}`,
      }
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    console.error('[extractWebsiteProxy] Error:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to extract website data',
    }
  }
}
