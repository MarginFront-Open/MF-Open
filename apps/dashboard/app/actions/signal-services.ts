'use server'

/**
 * Signal Services — links metrics (signals) to the services that power them.
 *
 * When a user says "Generate sourcing report uses Claude Sonnet 4.6 + Google Maps",
 * this creates two rows in signal_services linking that signal to those service_pricing entries.
 */

import { db } from '@/app/lib/db'
import { auth } from '@/app/lib/auth'
import { headers } from 'next/headers'
// A BUILD write, not a MONEY write. A signal's service list is its
// METER MAKEUP — which services power the metric (Claude + Google Maps, etc.). That is the
// operational metering plumbing the developers own (owner/admin), NOT an accounting number,
// so it sits behind the Build gate, not the money gate. Role is
// checked in the caller's active org, the same org these actions write to.
import { assertBuildManager } from './_shared/assert-build-manager'

export interface SignalServiceLink {
  id: string
  signalId: string
  servicePricingId: string
  service: {
    externalId: string
    displayName: string
    provider: string
    serviceType: string
    inputCost: number | null
    outputCost: number | null
    costUnit: string
    isApi: boolean
  }
}

/**
 * Get all services linked to a signal
 */
export async function getSignalServices(
  signalId: string
): Promise<{ success: boolean; data?: SignalServiceLink[]; error?: string }> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.session?.activeOrganizationId) {
      return { success: false, error: 'No active organization' }
    }

    const orgId = session.session.activeOrganizationId

    // Verify signal belongs to this org
    const signal = await db.signals.findFirst({
      where: {
        id: signalId,
        orgId,
        deletedAt: null,
      },
    })
    if (!signal) return { success: false, error: 'Signal not found' }

    const links = await db.signal_services.findMany({
      where: { signalId },
      include: {
        service_pricing: true,
      },
    })

    return {
      success: true,
      data: links.map((link) => ({
        id: link.id,
        signalId: link.signalId,
        servicePricingId: link.servicePricingId,
        service: {
          externalId: link.service_pricing.externalId,
          displayName: link.service_pricing.displayName,
          provider: link.service_pricing.provider,
          serviceType: link.service_pricing.serviceType,
          inputCost: link.service_pricing.inputCost
            ? Number(link.service_pricing.inputCost)
            : null,
          outputCost: link.service_pricing.outputCost
            ? Number(link.service_pricing.outputCost)
            : null,
          costUnit: link.service_pricing.costUnit,
          isApi: link.service_pricing.isApi,
        },
      })),
    }
  } catch (error) {
    console.error('Error fetching signal services:', error)
    return { success: false, error: 'Failed to fetch signal services' }
  }
}

/**
 * Set the services for a signal (replaces all existing links)
 * Pass an array of service_pricing externalIds.
 */
export async function setSignalServices(
  signalId: string,
  serviceExternalIds: string[]
): Promise<{ success: boolean; error?: string }> {
  try {
    // BUILD write: a signal's service makeup is operational metering plumbing — owner/admin only.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    // Verify signal belongs to this org
    const signal = await db.signals.findFirst({
      where: {
        id: signalId,
        orgId: gate.orgId,
        deletedAt: null,
      },
    })
    if (!signal) return { success: false, error: 'Signal not found' }

    // Look up the service_pricing IDs from external IDs
    const services = await db.service_pricing.findMany({
      where: {
        externalId: { in: serviceExternalIds },
        isActive: true,
      },
      select: { id: true, externalId: true },
    })

    // Delete existing links and create new ones in a transaction
    await db.$transaction([
      db.signal_services.deleteMany({ where: { signalId } }),
      ...services.map((service) =>
        db.signal_services.create({
          data: {
            id: crypto.randomUUID(),
            signalId,
            servicePricingId: service.id,
          },
        })
      ),
    ])

    return { success: true }
  } catch (error) {
    console.error('Error setting signal services:', error)
    return { success: false, error: 'Failed to set signal services' }
  }
}

/**
 * Update a signal's core fields AND replace its service links in one
 * transaction. This is what the metrics editor calls when the user saves
 * changes to an existing metric (edit-in-place).
 */
export async function updateSignalWithServices(data: {
  signalId: string
  name: string
  type?: 'volume' | 'usage'
  serviceExternalIds: string[]
}): Promise<{ success: boolean; error?: string }> {
  try {
    // BUILD write: editing a meter's definition and service makeup is operational — owner/admin only.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const name = data.name.trim()
    if (!name) {
      return {
        success: false,
        error:
          'The metric needs a name. It came through empty, so nothing was saved. Type a name and save again.',
      }
    }

    const signal = await db.signals.findFirst({
      where: {
        id: data.signalId,
        orgId: gate.orgId,
        deletedAt: null,
      },
    })
    if (!signal) return { success: false, error: 'Signal not found' }

    const services = await db.service_pricing.findMany({
      where: {
        externalId: { in: [...new Set(data.serviceExternalIds)] },
        isActive: true,
      },
      select: { id: true },
    })

    await db.$transaction([
      db.signals.update({
        where: { id: signal.id },
        data: {
          name,
          // shortName follows the display name, same as updateSignal in
          // signals.ts. Left alone when the name didn't change so a
          // type-or-services-only edit can't churn the stored shortName.
          ...(name !== signal.name
            ? { shortName: name.toLowerCase().replace(/\s+/g, '_') }
            : {}),
          type: data.type,
          updatedAt: new Date(),
        },
      }),
      db.signal_services.deleteMany({ where: { signalId: signal.id } }),
      ...services.map((service) =>
        db.signal_services.create({
          data: {
            id: crypto.randomUUID(),
            signalId: signal.id,
            servicePricingId: service.id,
          },
        })
      ),
    ])

    return { success: true }
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') {
      return {
        success: false,
        error:
          'That name is already taken by another metric on this agent. Metric names must be unique per agent, so pick a different name and save again.',
      }
    }
    console.error('Error updating signal with services:', error)
    return {
      success: false,
      error:
        'Your changes did not save. Something went wrong on our side while writing them. Try saving again, and reload the page if it keeps failing.',
    }
  }
}

/**
 * Create a signal AND link its services in one go.
 * This is what the wizard calls when the user finishes adding a metric.
 */
export async function createSignalWithServices(data: {
  name: string
  type?: 'volume' | 'usage'
  agentId: string
  serviceExternalIds: string[]
}): Promise<{ success: boolean; signalId?: string; error?: string }> {
  try {
    // BUILD write: defining a new meter and its service makeup is operational — owner/admin only.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = gate.orgId

    // Verify agent belongs to org
    const agent = await db.agents.findFirst({
      where: { id: data.agentId, orgId, deletedAt: null },
    })
    if (!agent) return { success: false, error: 'Agent not found' }

    // Look up service_pricing IDs
    const services = await db.service_pricing.findMany({
      where: {
        externalId: { in: data.serviceExternalIds },
        isActive: true,
      },
      select: { id: true },
    })

    // Create signal + service links in a transaction
    const signalId = crypto.randomUUID()
    const shortName = data.name.toLowerCase().replace(/\s+/g, '_')

    await db.$transaction([
      db.signals.create({
        data: {
          id: signalId,
          orgId,
          agentId: data.agentId,
          name: data.name,
          shortName,
          type: data.type || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      }),
      ...services.map((service) =>
        db.signal_services.create({
          data: {
            id: crypto.randomUUID(),
            signalId,
            servicePricingId: service.id,
          },
        })
      ),
    ])

    return { success: true, signalId }
  } catch (error) {
    console.error('Error creating signal with services:', error)
    return { success: false, error: 'Failed to create metric' }
  }
}
