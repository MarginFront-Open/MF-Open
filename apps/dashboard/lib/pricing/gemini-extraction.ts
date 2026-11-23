/**
 * Gemini-based Pricing Extraction
 *
 * Uses Google's Gemini API, which has a free tier.
 * Get your API key at: https://aistudio.google.com/app/apikey
 *
 * The model owns semantic understanding:
 * - Firecrawl provides markdown + screenshot
 * - Gemini Vision analyzes both and outputs structured JSON
 * - We validate but don't override the model's output
 */

import { GoogleGenerativeAI } from '@google/generative-ai'

let geminiClient: GoogleGenerativeAI | null = null

function getGemini(): GoogleGenerativeAI {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY not configured')
    }
    geminiClient = new GoogleGenerativeAI(apiKey)
  }
  return geminiClient
}

export interface GeminiPricingResult {
  pricingModel: string
  tiers: Array<{
    name: string
    basePrice: number | null
    billingCycle: 'monthly' | 'yearly' | 'one-time'
    priceUnit: string
    features: string[]
    isEnterprise: boolean
    includedUsage?: string
    overage?: string
  }>
  signals: Array<{
    name: string
    shortName: string
    type: 'usage' | 'volume'
    baseCost: number
    costUnit: string
  }>
}

const GEMINI_PRICING_PROMPT = `You are a pricing analyst. Analyze this pricing page and extract structured data.

PRICING PAGE URL: {url}

PRICING PAGE CONTENT:
{content}

---

CRITICAL INSTRUCTIONS:

1. IDENTIFY OVERAGE RATES vs BASE PRICES:
   - OVERAGE RATE: Any price with "per extra", "per additional", "per 1k", "per 1,000", etc. (e.g., "$9 per extra 1k credits")
   - BASE PRICE: The main subscription price shown prominently (e.g., "$16/mo", "$83/month")
   - If a price says "per extra X" or "per additional X", it is an OVERAGE RATE, NOT in basePrice

2. HANDLE MISSING BASE PRICES:
   - Some websites use animated counters or JavaScript that doesn't render in scraped content
   - If you see patterns like "$0123456789" or random digits, the actual price is NOT visible
   - If you CANNOT find a clear base subscription price for a tier, use null (don't guess)

3. KNOWN PRICING PATTERNS:
   - Free plans: basePrice = 0
   - Enterprise/Custom/Contact Us: basePrice = null, isEnterprise = true
   - One-time purchases (lifetime, once): billingCycle = "one-time"

4. BILLING CYCLE - CRITICAL DISTINCTION:

   billingCycle is determined by the PRICE UNIT text shown next to the amount:
   - "per month", "/mo", "/month", "monthly" → billingCycle: "monthly"
   - "per year", "/yr", "/year", "annually" → billingCycle: "yearly"
   - "one-time", "once", "lifetime", "one time" → billingCycle: "one-time"

   IMPORTANT: "Billed yearly" or "Billed annually" is PAYMENT FREQUENCY, not billingCycle!
   - "$599 per month, Billed yearly" → billingCycle: "monthly" (NOT yearly!)
   - This means $599/month rate, paid as $7,188/year

   EXAMPLES:
   - "$16/monthly" → basePrice: 16, billingCycle: "monthly"
   - "$599 per month" with "Billed yearly" toggle → basePrice: 599, billingCycle: "monthly"
   - "$5,988/year" → basePrice: 5988, billingCycle: "yearly"
   - "$0 one-time" → basePrice: 0, billingCycle: "one-time"

Return ONLY valid JSON (no markdown, no explanation):
{
  "pricingModel": "credit-based|tiered|usage-based|flat|hybrid|custom",
  "tiers": [
    {
      "name": "Hobby",
      "basePrice": 16,
      "billingCycle": "monthly",
      "priceUnit": "/mo",
      "features": ["3,000 credits/mo", "5 concurrent requests"],
      "isEnterprise": false,
      "includedUsage": "3,000 credits/month",
      "overage": "$9 per 1,000 extra credits"
    }
  ],
  "signals": [
    {
      "name": "API Credits",
      "shortName": "credits",
      "type": "usage",
      "baseCost": 1,
      "costUnit": "credit per page"
    }
  ]
}`

const GEMINI_VISION_PROMPT = `Look at this pricing page screenshot and extract the BASE SUBSCRIPTION PRICES.

The page may use animated price counters. Read the ACTUAL prices displayed in the screenshot for each tier.

TEXT CONTENT (for additional context):
{content}

---

CRITICAL - BILLING CYCLE DETECTION:

billingCycle is determined ONLY by the PRICE UNIT text shown directly next to the price amount:

✅ MONTHLY indicators (billingCycle: "monthly"):
   - "per month", "/mo", "/month", "monthly", "per mo"

✅ YEARLY indicators (billingCycle: "yearly"):
   - "per year", "/yr", "/year", "annually", "per annum"

✅ ONE-TIME indicators (billingCycle: "one-time"):
   - "one-time", "once", "lifetime", "one time"

⚠️ IGNORE PAYMENT FREQUENCY - It's NOT the billing cycle:
   - "Billed yearly", "Billed annually", "Billed monthly" = how often you PAY
   - This does NOT change the billingCycle!

CRITICAL EXAMPLES:
   - "$599 per month" with "Billed yearly" toggle ON
     → basePrice: 599, billingCycle: "monthly" ✅ (NOT yearly!)
     → The rate is $599/month, just paid annually

   - "$16/monthly" → basePrice: 16, billingCycle: "monthly" ✅

   - "$5,988/year" → basePrice: 5988, billingCycle: "yearly" ✅

   - "$0 one-time" or "500 credits (one-time)"
     → basePrice: 0, billingCycle: "one-time" ✅

   - "Custom" or "Contact us"
     → basePrice: null, isEnterprise: true ✅

CURRENCY HANDLING:
- Convert non-USD prices to USD (NOK/10, EUR*1.08, GBP*1.27)

Extract for each tier:
- name: tier name (NOT badges like "Most popular")
- basePrice: the price NUMBER shown (in USD), null for custom/enterprise
- billingCycle: "monthly" | "yearly" | "one-time" based on price unit text
- priceUnit: exact unit shown (e.g., "per month", "/mo", "/year", "one-time")
- includedUsage: what's included (e.g., "3,000 credits/month")
- overage: extra usage cost (e.g., "$9 per 1k extra credits")
- features: list of features
- isEnterprise: true if custom/contact us pricing

Return ONLY valid JSON:
{
  "pricingModel": "credit-based|tiered|usage-based|flat|hybrid",
  "tiers": [{ "name": "string", "basePrice": number|null, "billingCycle": "monthly|yearly|one-time", "priceUnit": "string", "features": [], "isEnterprise": false, "includedUsage": "string", "overage": "string|null" }],
  "signals": []
}`

export async function extractPricingWithGemini(
  pricingContent: string,
  url: string,
  screenshotUrl?: string,
  modelName?: string
): Promise<GeminiPricingResult> {
  const gemini = getGemini()
  // Use env var for model, with gemini-2.5-flash as default (higher quality for vision)
  const effectiveModel = modelName || process.env.GEMINI_MODEL || 'gemini-2.5-flash'
  const model = gemini.getGenerativeModel({ model: effectiveModel })

  console.log(`[Gemini] Analyzing pricing from: ${url}`)
  console.log(`[Gemini] Content length: ${pricingContent.length} chars`)
  console.log(`[Gemini] Screenshot: ${screenshotUrl ? 'available' : 'not available'}`)

  try {
    let result

    // Use vision with screenshot if available (better for animated prices)
    if (screenshotUrl) {
      console.log(`[Gemini] Using VISION mode with screenshot...`)
      const imgRes = await fetch(screenshotUrl)
      const imgBuffer = await imgRes.arrayBuffer()
      const base64Image = Buffer.from(imgBuffer).toString('base64')
      console.log(`[Gemini] Screenshot fetched (${Math.round(base64Image.length / 1024)}KB)`)

      const visionPrompt = GEMINI_VISION_PROMPT.replace('{content}', pricingContent.slice(0, 10000))

      result = await model.generateContent([
        visionPrompt,
        { inlineData: { mimeType: 'image/png', data: base64Image } }
      ])
    } else {
      // Text-only extraction
      console.log(`[Gemini] Using TEXT mode...`)
      const prompt = GEMINI_PRICING_PROMPT
        .replace('{url}', url)
        .replace('{content}', pricingContent.slice(0, 15000))

      result = await model.generateContent(prompt)
    }

    const response = result.response
    const text = response.text()

    console.log(`[Gemini] Response length: ${text.length} chars`)

    // Parse JSON from response
    let jsonText = text.trim()

    // Remove markdown code blocks if present
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```json?\s*/, '').replace(/\s*```$/, '')
    }

    // Find JSON object
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.error('[Gemini] Could not find JSON in response:', text.slice(0, 500))
      throw new Error('Could not find JSON in Gemini response')
    }

    const extracted = JSON.parse(jsonMatch[0]) as GeminiPricingResult

    console.log(`[Gemini] Extracted ${extracted.tiers?.length || 0} tiers`)
    console.log(`[Gemini] Pricing model: ${extracted.pricingModel}`)

    // Trust AI output - only validate, don't override
    const validatedTiers = (extracted.tiers || []).map((tier, index) => {
      let basePrice = tier.basePrice
      const billingCycle = tier.billingCycle || 'monthly'
      const priceUnit = tier.priceUnit || ''

      // Handle enterprise/custom tiers
      if (tier.isEnterprise) {
        basePrice = null
      }

      // Validation: Check if basePrice might be an overage rate (warn but don't override)
      if (basePrice && tier.overage) {
        const overagePriceMatch = tier.overage.match(/\$(\d+)/)
        if (overagePriceMatch) {
          const overagePrice = parseInt(overagePriceMatch[1], 10)
          if (basePrice === overagePrice) {
            console.warn(`[Gemini] ⚠️ Warning: ${tier.name} basePrice ($${basePrice}) matches overage price - may be incorrect`)
          }
        }
      }

      // Validation: Flag unusually high monthly prices (warn only)
      if (basePrice && basePrice > 5000 && billingCycle === 'monthly') {
        console.warn(`[Gemini] ⚠️ Warning: ${tier.name} has unusually high monthly price: $${basePrice}`)
      }

      // Log what AI extracted (trust it)
      console.log(`[Gemini] Tier "${tier.name}": $${basePrice} ${billingCycle} (priceUnit: "${priceUnit}")`)

      return {
        ...tier,
        id: `tier-${index}`,
        basePrice,
        billingCycle,
        priceUnit,
        features: tier.features || [],
        isEnterprise: tier.isEnterprise || false,
      }
    })

    return {
      pricingModel: extracted.pricingModel || 'tiered',
      tiers: validatedTiers,
      signals: extracted.signals || [],
    }
  } catch (error) {
    console.error('[Gemini] Error:', error)
    throw error
  }
}

export function isGeminiAvailable(): boolean {
  return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY)
}
