/**
 * LiteLLM Model Pricing Types and Utilities
 * Data source: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
 */

import { formatCost } from '@/lib/canon-format'

export interface LiteLLMModel {
  id: string // Model key from JSON (e.g., "gpt-4o", "claude-3-5-sonnet")
  displayName: string // Human-readable name
  provider: string // Normalized provider key (e.g., "openai", "anthropic")
  inputCost: number | null // Cost per 1M tokens (converted from per-token) or per unit
  outputCost: number | null // Cost per 1M tokens (converted from per-token) or per unit
  costUnit: string // Unit for cost: "1M tokens", "second", "image", "character", etc.
  mode: string // Model mode: chat, embedding, image_generation, etc.
  maxInputTokens: number | null
  maxOutputTokens: number | null
}

export interface LiteLLMRawModel {
  litellm_provider?: string
  // Token-based pricing
  input_cost_per_token?: number | null
  output_cost_per_token?: number | null
  // Time-based pricing (audio)
  input_cost_per_second?: number | null
  output_cost_per_second?: number | null
  // Image-based pricing
  input_cost_per_image?: number | null
  output_cost_per_image?: number | null
  input_cost_per_pixel?: number | null
  // Character-based pricing
  input_cost_per_character?: number | null
  output_cost_per_character?: number | null
  // Request-based pricing
  input_cost_per_request?: number | null
  output_cost_per_request?: number | null
  // Other fields
  mode?: string
  max_input_tokens?: number
  max_output_tokens?: number
  max_tokens?: number
  deprecation_date?: string
}

/**
 * Provider mapping: display name -> array of prefixes to match
 * Order matters - more specific prefixes should come first
 */
export const PROVIDER_MAP: Record<string, string[]> = {
  OpenAI: [
    'openai',
    'ft:gpt',
    'gpt-',
    'o1-',
    'o3-',
    'chatgpt-',
    'text-embedding',
    'whisper',
    'tts-',
    'dall-e',
  ],
  Anthropic: ['anthropic', 'claude'],
  Google: ['gemini', 'vertex_ai', 'google/', 'palm'],
  Azure: ['azure/', 'azure_ai'],
  AWS: ['bedrock/', 'amazon.', 'sagemaker'],
  Cohere: ['cohere', 'command'],
  Mistral: ['mistral'],
  xAI: ['xai/', 'grok'],
  DeepSeek: ['deepseek'],
  Meta: ['meta.', 'llama', 'meta-llama'],
  Groq: ['groq/'],
  Together: ['together_ai', 'together/'],
  Perplexity: ['perplexity'],
  Replicate: ['replicate'],
  AI21: ['ai21', 'j2-', 'jamba'],
  Voyage: ['voyage'],
  Other: [],
}

/**
 * Display names for providers (used in dropdowns)
 */
export const PROVIDER_DISPLAY_NAMES = Object.keys(PROVIDER_MAP)

/**
 * Map LiteLLM mode to user-friendly service name
 */
export const MODE_TO_SERVICE_NAME: Record<string, string> = {
  chat: 'LLM',
  completion: 'LLM',
  embedding: 'Embeddings',
  image_generation: 'Image Generation',
  audio_transcription: 'Speech-to-Text',
  audio_speech: 'Text-to-Speech',
  moderation: 'Moderation',
  rerank: 'Reranking',
}

/**
 * Reverse mapping: service name to LiteLLM modes
 */
export const SERVICE_NAME_TO_MODES: Record<string, string[]> = {
  LLM: ['chat', 'completion'],
  Embeddings: ['embedding'],
  'Image Generation': ['image_generation'],
  'Speech-to-Text': ['audio_transcription'],
  'Text-to-Speech': ['audio_speech'],
  Moderation: ['moderation'],
  Reranking: ['rerank'],
}

/**
 * Get service name from model mode
 */
export function getServiceNameFromMode(mode: string): string {
  return MODE_TO_SERVICE_NAME[mode] || 'LLM'
}

/**
 * Get LiteLLM modes for a service name
 */
export function getModesForServiceName(serviceName: string): string[] {
  return SERVICE_NAME_TO_MODES[serviceName] || []
}

/**
 * Normalize provider from model ID and litellm_provider field
 */
export function normalizeProvider(
  modelId: string,
  litellmProvider?: string
): string {
  const modelLower = modelId.toLowerCase()
  const providerLower = (litellmProvider || '').toLowerCase()

  // Check each provider's prefixes
  for (const [displayName, prefixes] of Object.entries(PROVIDER_MAP)) {
    if (displayName === 'Other') continue

    for (const prefix of prefixes) {
      // Check model ID
      if (modelLower.startsWith(prefix) || modelLower.includes('/' + prefix)) {
        return displayName
      }
      // Check litellm_provider field
      if (
        providerLower === prefix.replace('/', '') ||
        providerLower.startsWith(prefix.replace('/', ''))
      ) {
        return displayName
      }
    }
  }

  // Special cases based on litellm_provider
  if (providerLower.includes('openai')) return 'OpenAI'
  if (providerLower.includes('anthropic')) return 'Anthropic'
  if (
    providerLower.includes('vertex') ||
    providerLower.includes('google') ||
    providerLower.includes('gemini')
  )
    return 'Google'
  if (providerLower.includes('azure')) return 'Azure'
  if (providerLower.includes('bedrock') || providerLower.includes('sagemaker'))
    return 'AWS'
  if (providerLower.includes('cohere')) return 'Cohere'
  if (providerLower.includes('mistral')) return 'Mistral'
  if (providerLower.includes('groq')) return 'Groq'
  if (providerLower.includes('together')) return 'Together'
  if (providerLower.includes('replicate')) return 'Replicate'
  if (providerLower.includes('perplexity')) return 'Perplexity'
  if (providerLower.includes('ai21')) return 'AI21'
  if (providerLower.includes('voyage')) return 'Voyage'
  if (providerLower.includes('deepseek')) return 'DeepSeek'
  if (providerLower.includes('xai')) return 'xAI'

  return 'Other'
}

/**
 * Extract a clean display name from model ID
 */
export function extractDisplayName(modelId: string): string {
  let name = modelId

  // Remove common provider prefixes
  const prefixPatterns = [
    /^openai\//,
    /^anthropic\//,
    /^azure\/.+?\//, // azure/region/model
    /^azure_ai\//,
    /^bedrock\/.+?\//, // bedrock/region/model
    /^vertex_ai\/.+?\//,
    /^vertex_ai-[^/]+\//,
    /^google\//,
    /^cohere\//,
    /^cohere_chat\//,
    /^mistral\//,
    /^groq\//,
    /^together_ai\//,
    /^together\//,
    /^replicate\//,
    /^perplexity\//,
    /^deepseek\//,
    /^xai\//,
    /^sagemaker\//,
    /^\d+x\d+\//, // image size prefixes like 1024-x-1024/
    /^\d+-x-\d+\//,
    /^ft:gpt-/, // fine-tuned prefix
  ]

  for (const pattern of prefixPatterns) {
    name = name.replace(pattern, '')
  }

  // Remove version suffixes that are too long
  // Keep short versions like -v1, -v2, but clean up long hashes
  name = name.replace(/-[a-f0-9]{8,}$/i, '')

  // Clean up the name for display
  return name
    .split(/[-_]/)
    .map((word) => {
      // Handle common abbreviations
      if (word.toLowerCase() === 'gpt') return 'GPT'
      if (word.toLowerCase() === 'ai') return 'AI'
      if (word.toLowerCase() === 'xl') return 'XL'
      if (word.toLowerCase() === 'llm') return 'LLM'
      // Capitalize first letter
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Format cost for display (converts per-token to per-1M tokens string)
 */
export function formatCostDisplay(costPerToken: number | null): string {
  if (costPerToken === null || costPerToken === undefined) return 'N/A'

  // Convert to per 1M tokens
  const perMillion = costPerToken * 1_000_000

  return formatCost(perMillion)
}

/**
 * Transform raw LiteLLM JSON entry into normalized LiteLLMModel
 * Handles multiple pricing formats: per-token, per-second, per-image, per-character, per-request
 */
export function transformRawModel(
  id: string,
  raw: LiteLLMRawModel
): LiteLLMModel {
  let inputCost: number | null = null
  let outputCost: number | null = null
  let costUnit = '1M tokens'

  // Token-based pricing (most common - convert to per 1M tokens)
  if (
    raw.input_cost_per_token !== undefined &&
    raw.input_cost_per_token !== null
  ) {
    inputCost = raw.input_cost_per_token * 1_000_000
    outputCost =
      raw.output_cost_per_token !== undefined &&
      raw.output_cost_per_token !== null
        ? raw.output_cost_per_token * 1_000_000
        : null
    costUnit = '1M tokens'
  }
  // Time-based pricing (audio models)
  else if (
    raw.input_cost_per_second !== undefined &&
    raw.input_cost_per_second !== null
  ) {
    inputCost = raw.input_cost_per_second
    outputCost = raw.output_cost_per_second ?? null
    costUnit = 'second'
  }
  // Image-based pricing
  else if (
    raw.input_cost_per_image !== undefined &&
    raw.input_cost_per_image !== null
  ) {
    inputCost = raw.input_cost_per_image
    outputCost = raw.output_cost_per_image ?? null
    costUnit = 'image'
  }
  // Pixel-based pricing
  else if (
    raw.input_cost_per_pixel !== undefined &&
    raw.input_cost_per_pixel !== null
  ) {
    inputCost = raw.input_cost_per_pixel * 1_000_000 // Convert to per 1M pixels
    outputCost = null
    costUnit = '1M pixels'
  }
  // Character-based pricing (some TTS models)
  else if (
    raw.input_cost_per_character !== undefined &&
    raw.input_cost_per_character !== null
  ) {
    inputCost = raw.input_cost_per_character * 1_000_000 // Convert to per 1M characters
    outputCost =
      raw.output_cost_per_character !== undefined &&
      raw.output_cost_per_character !== null
        ? raw.output_cost_per_character * 1_000_000
        : null
    costUnit = '1M characters'
  }
  // Request-based pricing
  else if (
    raw.input_cost_per_request !== undefined &&
    raw.input_cost_per_request !== null
  ) {
    inputCost = raw.input_cost_per_request
    outputCost = raw.output_cost_per_request ?? null
    costUnit = 'request'
  }

  return {
    id,
    displayName: extractDisplayName(id),
    provider: normalizeProvider(id, raw.litellm_provider),
    inputCost,
    outputCost,
    costUnit,
    mode: raw.mode || 'chat',
    maxInputTokens: raw.max_input_tokens ?? raw.max_tokens ?? null,
    maxOutputTokens: raw.max_output_tokens ?? raw.max_tokens ?? null,
  }
}
