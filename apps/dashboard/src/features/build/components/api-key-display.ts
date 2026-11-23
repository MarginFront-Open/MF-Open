/**
 * Pure, node-testable
 * view model for the Build page's API-keys rows. The contract is
 * reproduced exactly: secret (mf_sk_) keys are hash-only at rest and the
 * read action (getApiKeys) already returns either a masked stub or
 * nothing. This model passes that stub through UNTOUCHED and
 * never offers a copy value for it, because no full secret exists to copy.
 * Publishable (mf_pk_) keys arrive as full plaintext (frontend-safe): masked
 * for display, full value only as the copy/reveal payload.
 */

import { formatDistanceToNow } from 'date-fns'
import type { ApiKey } from '@/app/actions/api-keys'
import { keyPrefix } from '@/lib/api-key-mask'

export interface KeyCellModel {
  /** What the cell renders by default. */
  masked: string
  /** Full plaintext for reveal/copy — null means NO reveal/copy affordance. */
  full: string | null
}

export function keyCellModel(
  key: Pick<ApiKey, 'keyType' | 'apiKeyPlaintext'>
): KeyCellModel {
  if (!key.apiKeyPlaintext) return { masked: '—', full: null }
  if (key.keyType === 'secret') {
    return { masked: key.apiKeyPlaintext, full: null }
  }
  return {
    masked: maskForDisplay(key.apiKeyPlaintext),
    full: key.apiKeyPlaintext,
  }
}

// The mask uses keyPrefix, never a lastIndexOf('_') cut: the random half is
// base64url, an alphabet that includes '_', so that cut would expose random
// characters. See keyPrefix in lib/api-key-mask.
function maskForDisplay(plaintext: string): string {
  const prefix = keyPrefix(plaintext)
  // Needs room for at least 4 random chars between the prefix and the visible
  // last-4, or a short key would render mostly unmasked.
  if (!prefix || plaintext.length < prefix.length + 8) return '•'.repeat(20)
  return `${prefix}${'•'.repeat(12)}${plaintext.slice(-4)}`
}

/**
 * The honest Type column: real keys have no live/test segment and no
 * read-write scope — the facts are keyType + where the key is safe to live.
 */
export function keyTypeLabel(keyType: ApiKey['keyType']): string {
  return keyType === 'secret'
    ? 'Secret · server-side'
    : 'Publishable · frontend-safe'
}

export function lastUsedLabel(lastUsedAt: Date | string | null): string {
  if (lastUsedAt === null) return 'Never used'
  return formatDistanceToNow(new Date(lastUsedAt), { addSuffix: true })
}

/**
 * Status column for the Build API-keys tab. A TOTAL
 * Record over ApiKey['status'] — a new status is a compile error here, not
 * a silent unstyled cell.
 */
export const KEY_STATUS_CHIPS: Record<
  ApiKey['status'],
  { label: string; className: string }
> = {
  active: { label: 'Active', className: 'bg-mf-card2 text-mf-green' },
  revoked: { label: 'Revoked', className: 'bg-mf-card2 text-mf-red' },
}
