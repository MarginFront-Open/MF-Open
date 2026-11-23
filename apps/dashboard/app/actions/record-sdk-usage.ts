'use server'

import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'

/**
 * Server Action: SDK simulator → NestJS API proxy
 *
 * The SDK simulator sends a test event to the NestJS SDK ingestion endpoint
 * using a secret key the user pastes in — the same one they copied when they
 * created it, exactly like a real SDK client. The key is forwarded unchanged;
 * nothing about it is read from or resolved against storage.
 *
 * Calling the NestJS API directly from the browser fails with "Failed to fetch"
 * because of CORS — different origin (localhost:3000 → api.example.com or
 * localhost:4000), no preflight, no credentials. This Server Action runs
 * server-side, forwards the request from there, and returns the response;
 * server-to-server calls have no CORS issues.
 *
 * Why proxy instead of writing directly to the DB:
 * - The NestJS SdkService does auto-provisioning, model lookup, cost
 *   calculation, raw event storage, and signal event creation. Reimplementing
 *   all of that here would duplicate logic and drift over time.
 * - This way the simulator exercises the actual production ingestion path,
 *   which is the whole point of a simulator.
 */

export interface SdkUsageRecord {
  customerExternalId: string
  agentCode: string
  signalName: string
  model: string
  // Optional because non-LLM services (Textract, DALL-E, Twilio) don't have
  // tokens. The NestJS DTO accepts these as optional and the cost calculator
  // defaults missing values to 0 in the LLM branch (which then short-circuits
  // because the row's costUnit isn't '1M tokens' anyway).
  inputTokens?: number
  outputTokens?: number
  // Quantity of billable units. Optional and defaults to 1 server-side.
  // For non-LLM services this is the actual unit count (pages, images,
  // minutes); for LLM it's metadata for the customer's pricing plan.
  quantity?: number
  usageDate?: string
  metadata?: Record<string, unknown>
}

export interface RecordSdkUsageResult {
  success: boolean
  status: number
  data?: Record<string, unknown>
  error?: string
  latencyMs: number
}

export async function recordSdkUsage(
  apiKey: string,
  records: SdkUsageRecord[]
): Promise<RecordSdkUsageResult> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL

  if (!apiBaseUrl) {
    return {
      success: false,
      status: 0,
      error:
        'NEXT_PUBLIC_API_BASE_URL is not set on the server. Add it to .env.local.',
      latencyMs: 0,
    }
  }

  // Require a logged-in session so this action can't be used as an open relay
  // to the ingestion API. The session does NOT resolve the key — the user
  // supplies that — it only gates who may proxy a request.
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.session?.activeOrganizationId) {
    return {
      success: false,
      status: 0,
      error: 'Not authenticated or no active organization.',
      latencyMs: 0,
    }
  }

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return {
      success: false,
      status: 0,
      error: 'Paste a secret key first.',
      latencyMs: 0,
    }
  }

  if (!apiKey.startsWith('mf_sk_')) {
    return {
      success: false,
      status: 0,
      error:
        "Paste a secret key (starts with mf_sk_). Publishable keys can't send usage.",
      latencyMs: 0,
    }
  }

  if (!records || records.length === 0) {
    return {
      success: false,
      status: 0,
      error: 'At least one record is required.',
      latencyMs: 0,
    }
  }

  const startTime = performance.now()

  try {
    const res = await fetch(`${apiBaseUrl}/sdk/usage/record`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ records }),
    })

    const latencyMs = Math.round(performance.now() - startTime)

    // Try to parse JSON regardless of status — error responses also have bodies
    let data: Record<string, unknown> = {}
    try {
      data = await res.json()
    } catch {
      // Non-JSON response (e.g. HTML error page from a misrouted call)
      data = { message: 'Response was not valid JSON' }
    }

    if (!res.ok) {
      console.error(
        '[recordSdkUsage] NestJS API returned error:',
        res.status,
        data
      )
      return {
        success: false,
        status: res.status,
        data,
        latencyMs,
      }
    }

    console.log(
      '[recordSdkUsage] Event recorded successfully in',
      latencyMs,
      'ms'
    )
    return {
      success: true,
      status: res.status,
      data,
      latencyMs,
    }
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const message = error instanceof Error ? error.message : 'Unknown error'

    console.error('[recordSdkUsage] Failed to reach NestJS API:', message)

    // Distinguish "API not reachable" from other failures so the user
    // gets an actionable error message
    const isConnectionError =
      message.includes('ECONNREFUSED') ||
      message.includes('fetch failed') ||
      message.includes('ENOTFOUND')

    return {
      success: false,
      status: 0,
      error: isConnectionError
        ? `Could not reach the NestJS API at ${apiBaseUrl}. Is it running? (${message})`
        : message,
      latencyMs,
    }
  }
}
