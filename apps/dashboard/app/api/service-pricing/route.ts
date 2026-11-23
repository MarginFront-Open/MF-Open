import { NextResponse } from 'next/server'
import { db as prisma } from '@/app/lib/db'

/**
 * Serves service pricing data from the database.
 * The DB is populated by the sync script (packages/db/scripts/sync-service-pricing.ts).
 */
export async function GET() {
  try {
    const entries = await prisma.service_pricing.findMany({
      where: { isActive: true },
      orderBy: { displayName: 'asc' },
    })

    // Collect unique service types in a sensible order
    const typeSet = new Set<string>()
    entries.forEach((e) => typeSet.add(e.serviceType))

    const preferredOrder = [
      'LLM',
      'Image Generation',
      'Video Generation',
      'Embeddings',
      'Speech-to-Text',
      'Text-to-Speech',
      'Moderation',
      'Reranking',
      'Web Search',
      'Web Scraping',
      'Email',
      'SMS',
      'Voice',
      'Maps',
      'Document Processing',
      'Code Execution',
      'Data Enrichment',
      'Vector Database',
    ]

    const serviceTypes = [
      ...preferredOrder.filter((t) => typeSet.has(t)),
      ...Array.from(typeSet)
        .filter((t) => !preferredOrder.includes(t))
        .sort(),
      'Custom',
    ]

    // Map DB rows to the shape the frontend expects
    const mapped = entries.map((e) => ({
      id: e.externalId,
      canonicalName: e.canonicalName,
      displayName: e.displayName,
      provider: e.provider,
      serviceType: e.serviceType,
      inputCost: e.inputCost ? Number(e.inputCost) : null,
      outputCost: e.outputCost ? Number(e.outputCost) : null,
      // `!= null`, not the truthy test used above: a stored 0 is a real FREE
      // rate; collapsing it to null would warn on a priceable row.
      cacheReadCost: e.cacheReadCost != null ? Number(e.cacheReadCost) : null,
      cacheWriteCost:
        e.cacheWriteCost != null ? Number(e.cacheWriteCost) : null,
      costUnit: e.costUnit,
      contextWindow: e.contextWindow,
      isApi: e.isApi,
    }))

    return NextResponse.json({
      models: mapped.filter((e) => !e.isApi),
      apis: mapped.filter((e) => e.isApi),
      serviceTypes,
      lastUpdated: entries[0]?.updatedAt || new Date().toISOString(),
    })
  } catch (error) {
    console.error('[api/service-pricing] Error:', error)
    return NextResponse.json(
      { models: [], apis: [], serviceTypes: ['Custom'], lastUpdated: null },
      { status: 200 }
    )
  }
}
