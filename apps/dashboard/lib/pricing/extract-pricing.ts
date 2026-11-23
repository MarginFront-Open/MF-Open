/**
 * Gemini-based Pricing Extraction
 *
 * Uses Google Gemini (free tier) for pricing extraction with vision support.
 * Vision mode enables reading animated prices from screenshots.
 */

import {
  extractPricingWithGemini,
  isGeminiAvailable,
} from './gemini-extraction'

// ============================================================================
// Types
// ============================================================================

export interface IncludedUsage {
  metric: string
  amount: number | string
  period: string
}

export interface Overage {
  cost: number
  unit: string
}

export interface MarginFrontTier {
  id: string
  name: string
  basePrice: number | null
  billingCycle: 'monthly' | 'yearly' | 'one-time'
  priceUnit: string
  features: string[]
  isEnterprise: boolean
  includedUsage?: IncludedUsage[]
  overage?: Overage
}

export interface MarginFrontSignal {
  id: string
  name: string
  shortName: string
  type?: 'usage' | 'volume'
  baseCost: number
  costUnit: string
}

export interface MarginFrontPricing {
  pricingModel: string
  tiers: MarginFrontTier[]
  signals: MarginFrontSignal[]
}

export interface PricingAnalysis {
  pricingModel: string
  rawAnalysis: string
}

export interface ExtractionResult {
  success: boolean
  data: MarginFrontPricing | null
  analysis: PricingAnalysis | null
  confidence: 'high' | 'medium' | 'low'
  warnings: string[]
  method: 'gemini' | 'fallback'
  error?: string
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Main extraction function - Gemini only
 *
 * Uses Gemini for pricing extraction with retry logic for rate limiting.
 */
export async function extractPricing(
  pricingPageUrl: string,
  pricingContent: string,
  screenshotUrl?: string
): Promise<ExtractionResult> {
  console.log('[Pricing] Starting pricing extraction...')
  console.log(`[Pricing] URL: ${pricingPageUrl}`)
  console.log(`[Pricing] Content length: ${pricingContent.length} chars`)
  console.log(`[Pricing] Screenshot: ${screenshotUrl ? 'available' : 'not available'}`)

  // With a screenshot, Gemini uses vision to read animated prices.
  if (!isGeminiAvailable()) {
    console.error('[Pricing] Gemini API key not configured')
    return {
      success: false,
      data: null,
      analysis: null,
      confidence: 'low',
      warnings: ['Gemini API key not configured'],
      method: 'fallback',
      error: 'Gemini API key not configured - please set GEMINI_API_KEY',
    }
  }

  const maxRetries = 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Pricing] Gemini extraction attempt ${attempt}/${maxRetries}...`)
      const result = await extractWithGeminiWrapper(pricingPageUrl, pricingContent, screenshotUrl)
      if (result.success && result.data && result.data.tiers.length > 0) {
        console.log('[Pricing] ✓ Gemini extraction succeeded')
        return result
      }
      console.warn('[Pricing] Gemini returned no tiers')
      // Return the result even if no tiers - don't retry for empty results
      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const errorMessage = lastError.message

      if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests')) {
        const retryMatch = errorMessage.match(/retry in ([\d.]+)s/i)
        const retryDelay = retryMatch ? Math.ceil(parseFloat(retryMatch[1]) * 1000) : 15000

        if (attempt < maxRetries) {
          console.log(`[Pricing] Rate limited, waiting ${retryDelay / 1000}s before retry...`)
          await new Promise(resolve => setTimeout(resolve, retryDelay + 1000))
          continue
        }
      }

      console.error(`[Pricing] Gemini attempt ${attempt} failed:`, errorMessage)
    }
  }

  console.error('[Pricing] All Gemini extraction attempts failed')
  return {
    success: false,
    data: null,
    analysis: null,
    confidence: 'low',
    warnings: ['Gemini extraction failed after retries'],
    method: 'fallback',
    error: lastError?.message || 'Could not extract pricing from this page',
  }
}

// ============================================================================
// Gemini Wrapper
// ============================================================================

async function extractWithGeminiWrapper(
  url: string,
  content: string,
  screenshotUrl?: string
): Promise<ExtractionResult> {
  const data = await extractPricingWithGemini(content, url, screenshotUrl)

  const marginFrontData: MarginFrontPricing = {
    pricingModel: data.pricingModel,
    tiers: data.tiers.map((tier, index) => ({
      id: `tier-${index}`,
      name: tier.name,
      basePrice: tier.basePrice,
      billingCycle: tier.billingCycle,
      priceUnit: tier.priceUnit,
      features: tier.features,
      isEnterprise: tier.isEnterprise,
    })),
    signals: data.signals.map((signal, index) => ({
      id: `signal-${index}`,
      name: signal.name,
      shortName: signal.shortName,
      type: signal.type,
      baseCost: signal.baseCost,
      costUnit: signal.costUnit,
    })),
  }

  const warnings = validateExtraction(marginFrontData, content)

  return {
    success: true,
    data: marginFrontData,
    analysis: null,
    confidence: warnings.length === 0 ? 'high' : 'medium',
    warnings: [...warnings, 'Extracted using Gemini (free tier)'],
    method: 'gemini',
  }
}

// ============================================================================
// Validation
// ============================================================================

function validateExtraction(extracted: MarginFrontPricing, originalContent: string): string[] {
  const warnings: string[] = []

  for (const tier of extracted.tiers) {
    if (tier.basePrice === 0 && tier.name && !tier.name.toLowerCase().includes('free')) {
      warnings.push(`${tier.name} has $0 price but isn't a free tier - verify this is correct`)
    }

    if (tier.basePrice && tier.basePrice > 0) {
      const priceStr = tier.basePrice.toString()
      if (!originalContent.includes(priceStr) && !originalContent.includes(`$${priceStr}`)) {
        warnings.push(`${tier.name} price ($${tier.basePrice}) not found in original content - may be incorrect`)
      }
    }
  }

  if (extracted.tiers.length === 0) {
    warnings.push('No pricing tiers extracted')
  }

  const totalFeatures = extracted.tiers.reduce((sum, t) => sum + t.features.length, 0)
  if (totalFeatures < 3 && extracted.tiers.length > 0) {
    warnings.push('Very few features extracted - page may need manual review')
  }

  return warnings
}

// ============================================================================
// Utilities
// ============================================================================

export { isGeminiAvailable }

export function getAvailableMethods(): string[] {
  const methods: string[] = []
  if (isGeminiAvailable()) {
    methods.push('gemini')
  }
  return methods
}
