/**
 * Pricing Extraction Module
 *
 * Uses Google Gemini (free tier) for extracting pricing from any website.
 * Supports vision mode for reading animated prices from screenshots.
 *
 * @example
 * ```typescript
 * import { extractPricing, isGeminiAvailable } from '@/lib/pricing'
 *
 * if (isGeminiAvailable()) {
 *   const result = await extractPricing(pricingUrl, pricingContent, screenshotUrl)
 *   if (result.success) {
 *     console.log(result.data.tiers)
 *     console.log(result.data.signals)
 *   }
 * }
 * ```
 */

export {
  extractPricing,
  isGeminiAvailable,
  getAvailableMethods,
  type ExtractionResult,
  type PricingAnalysis,
  type MarginFrontPricing,
  type MarginFrontTier,
  type MarginFrontSignal,
  type IncludedUsage,
  type Overage,
} from './extract-pricing'

export {
  extractPricingWithGemini,
  type GeminiPricingResult,
} from './gemini-extraction'
