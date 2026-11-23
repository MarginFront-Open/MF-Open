'use server'

/**
 * API Keys Server Actions
 * Server-side actions for managing API keys
 */

import { headers } from 'next/headers'
import { auth } from '@/app/lib/auth'
import { db } from '@/app/lib/db'
// The deterministic lookup hash stored on every key so
// api-nest's validateApiKey can find it by hash. This is the SAME function
// api-nest uses on write and on verify (imported from @marginfront/db), so the
// dashboard and the backend provably agree on the stored value.
import {
  generateApiKey,
  hashApiKeyForLookup,
  mintableKeyRoles,
  mintedKeyPermissions,
  secretPairKeyCreateData,
  parseKeyRole,
  revokePortalAccessForOrg,
  type KeyRole,
} from '@marginfront/db'
// deleteApiKey (below) is a soft delete (deletedAt) that no dashboard surface
// calls; it uses the BUILD gate. create/pair/revoke use assertKeyMinter (see
// the comment at each call site).
import { assertBuildManager } from './_shared/assert-build-manager'
import { assertKeyMinter } from './_shared/assert-key-minter'

// Types
export interface ApiKey {
  id: string
  name: string
  description: string | null
  apiKeyPlaintext?: string // Only returned when key is created
  keyPrefix: string | null
  keyType: 'secret' | 'publishable'
  // enum_api_keys_status holds exactly these two; widening the union breaks
  // KEY_STATUS_CHIPS, a TOTAL Record over it.
  status: 'active' | 'revoked'
  permissions: string[]
  // The dashboard role the key carries (parseKeyRole in @marginfront/db floors
  // malformed or missing data to 'ingest'), plus provenance so the UI can flag
  // a backfilled key or one minted by someone since demoted.
  role: KeyRole
  legacy: boolean
  minterUserId: string | null
  minterRole: string | null
  lastUsedAt: Date | null
  createdAt: Date
}

export interface CreateApiKeyParams {
  name: string
  description?: string
  keyType?: 'secret' | 'publishable'
  permissions?: string[]
  // The key role to mint, capped server-side by
  // mintableKeyRoles(minterRole). Omitted = the 'ingest' floor (least
  // privilege by default).
  role?: KeyRole
}

/**
 * Reads the provenance fields the create/pair actions below (and api-nest's
 * mint service) write into api_keys.permissions alongside the role: who
 * minted the key and what role THEY held at mint time. Defensive like
 * parseKeyRole in @marginfront/db — a hand-edited or incomplete
 * blob yields nulls, never throws.
 */
function readKeyProvenance(permissions: unknown): {
  legacy: boolean
  minterUserId: string | null
  minterRole: string | null
} {
  if (
    permissions === null ||
    typeof permissions !== 'object' ||
    Array.isArray(permissions)
  ) {
    return { legacy: false, minterUserId: null, minterRole: null }
  }
  const blob = permissions as Record<string, unknown>
  return {
    legacy: blob.legacy === true,
    minterUserId:
      typeof blob.minterUserId === 'string' ? blob.minterUserId : null,
    minterRole: typeof blob.minterRole === 'string' ? blob.minterRole : null,
  }
}

export interface ApiKeyCreatedResponse extends ApiKey {
  apiKeyPlaintext: string // Full key shown only once at creation
}

type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

/**
 * Get all API keys for the current organization
 */
export async function getApiKeys(): Promise<ActionResult<ApiKey[]>> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    const orgId = session.session.activeOrganizationId

    const apiKeys = await db.api_keys.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    })

    const formattedKeys: ApiKey[] = apiKeys.map((key: any) => ({
      id: key.id,
      name: key.name,
      description: key.description,
      // Publishable (mf_pk_*) keys are frontend-safe, so they're returned in full.
      // Secret keys store no plaintext, so they come back undefined (or masked to
      // `<prefix>...<last4>` when a row holds one). The full secret is shown ONCE at
      // creation (createApiKey / createApiKeyPair below return it) — never on read.
      apiKeyPlaintext:
        key.keyType === 'publishable'
          ? key.apiKeyPlaintext || undefined // frontend-safe key — full value is fine
          : key.apiKeyPlaintext
            ? `${key.keyPrefix ?? ''}...${key.apiKeyPlaintext.slice(-4)}`
            : undefined, // secret key — masked, never the full plaintext
      keyPrefix: key.keyPrefix,
      keyType: (key.keyType as 'secret' | 'publishable') || 'secret',
      status: (key.status as 'active' | 'revoked') || 'active',
      permissions: (key.permissions as string[]) || [],
      role: parseKeyRole(key.permissions),
      ...readKeyProvenance(key.permissions),
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
    }))

    return { success: true, data: formattedKeys }
  } catch (error) {
    console.error('Error in getApiKeys:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get API keys',
    }
  }
}

/**
 * Create a new API key
 * Returns the full plaintext key only at creation time
 */
export async function createApiKey(
  params: CreateApiKeyParams
): Promise<ActionResult<ApiKeyCreatedResponse>> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId || !session?.user?.id) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // The mint door is MINT_KEY_ROLES (owner/admin/developer/
    // finance), wider than MANAGE_BUILD_ROLES by 'finance'.
    const gate = await assertKeyMinter()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    const { name, description, keyType = 'secret', role } = params

    if (!name || name.trim().length === 0) {
      return { success: false, error: 'API key name is required' }
    }

    // Default to the least-privilege role. A publishable key is
    // ALWAYS 'member' (read-capped by the interceptor regardless of role) —
    // mirrors the pair endpoint's pk-gets-member rule below.
    const chosenRole: KeyRole =
      keyType === 'publishable' ? 'member' : (role ?? 'ingest')
    if (!mintableKeyRoles(gate.minterRole).includes(chosenRole)) {
      return {
        success: false,
        error:
          `Your role (${gate.minterRole}) cannot create a "${chosenRole}" key. ` +
          `You can create: ${mintableKeyRoles(gate.minterRole).join(', ') || 'nothing'}.`,
      }
    }
    const permissions = mintedKeyPermissions(chosenRole, {
      minterUserId: userId,
      minterRole: gate.minterRole,
    })

    // Generate secure API key
    const { plaintext, hash, prefix } = generateApiKey(keyType)

    const apiKey = await db.api_keys.create({
      data: {
        id: crypto.randomUUID(),
        name: name.trim(),
        description: description?.trim() || null,
        organizationId: orgId,
        createdById: userId,
        apiKeyHash: hash,
        // Only publishable keys persist their plaintext (frontend-safe).
        // Secret keys are hash-only at rest; the full value is returned once below.
        apiKeyPlaintext: keyType === 'publishable' ? plaintext : null,
        apiKeyLookupHash: hashApiKeyForLookup(plaintext),
        keyPrefix: prefix,
        keyType: keyType,
        status: 'active',
        permissions,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    const response: ApiKeyCreatedResponse = {
      id: apiKey.id,
      name: apiKey.name,
      description: apiKey.description,
      apiKeyPlaintext: plaintext, // Only returned at creation
      keyPrefix: apiKey.keyPrefix,
      keyType: (apiKey.keyType as 'secret' | 'publishable') || 'secret',
      status: (apiKey.status as 'active' | 'revoked') || 'active',
      permissions: [],
      role: chosenRole,
      legacy: false,
      minterUserId: userId,
      minterRole: gate.minterRole,
      lastUsedAt: apiKey.lastUsedAt,
      createdAt: apiKey.createdAt,
    }

    return { success: true, data: response }
  } catch (error) {
    console.error('Error in createApiKey:', error)
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to create API key',
    }
  }
}

export interface ApiKeyPairResponse {
  secretKey: ApiKeyCreatedResponse
  publishableKey: ApiKeyCreatedResponse
  message: string
}

/**
 * Create a key pair (secret + publishable) - RECOMMENDED
 * This is the industry-standard approach (like Stripe/Chargebee)
 * - Secret key (mf_sk_*): Use server-side only, never expose to frontend
 * - Publishable key (mf_pk_*): Safe to use in frontend/browser code
 */
export async function createApiKeyPair(
  params: CreateApiKeyParams
): Promise<ActionResult<ApiKeyPairResponse>> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId || !session?.user?.id) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // Same mint door as createApiKey above — MINT_KEY_ROLES,
    // not the narrower MANAGE_BUILD_ROLES.
    const gate = await assertKeyMinter()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId
    const userId = session.user.id

    const { name, description, role } = params

    if (!name || name.trim().length === 0) {
      return { success: false, error: 'API key name is required' }
    }

    // Default to the least-privilege role for the secret half; the
    // publishable half is ALWAYS 'member' — it's read-capped by the
    // interceptor regardless of what the secret half carries.
    const chosenRole: KeyRole = role ?? 'ingest'
    if (!mintableKeyRoles(gate.minterRole).includes(chosenRole)) {
      return {
        success: false,
        error:
          `Your role (${gate.minterRole}) cannot create a "${chosenRole}" key. ` +
          `You can create: ${mintableKeyRoles(gate.minterRole).join(', ') || 'nothing'}.`,
      }
    }
    const publishablePermissions = mintedKeyPermissions('member', {
      minterUserId: userId,
      minterRole: gate.minterRole,
    })

    // Generate both secret and publishable keys
    const secretKeyData = generateApiKey('secret')
    const publishableKeyData = generateApiKey('publishable')

    // secretPairKeyCreateData is the one shared builder for this row; keep it
    // that way rather than inlining fields here.
    const secretKey = await db.api_keys.create({
      data: secretPairKeyCreateData({
        name,
        description,
        organizationId: orgId,
        role: chosenRole,
        minterUserId: userId,
        minterRole: gate.minterRole,
        key: secretKeyData,
      }),
    })

    // Create publishable key
    const publishableKey = await db.api_keys.create({
      data: {
        id: crypto.randomUUID(),
        name: `${name.trim()} (Publishable)`,
        description:
          description?.trim() ||
          'Frontend-safe API key - can be exposed in browser code',
        organizationId: orgId,
        createdById: userId,
        apiKeyHash: publishableKeyData.hash,
        apiKeyPlaintext: publishableKeyData.plaintext,
        apiKeyLookupHash: hashApiKeyForLookup(publishableKeyData.plaintext),
        keyPrefix: publishableKeyData.prefix,
        keyType: 'publishable',
        status: 'active',
        permissions: publishablePermissions,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    const response: ApiKeyPairResponse = {
      secretKey: {
        id: secretKey.id,
        name: secretKey.name,
        description: secretKey.description,
        apiKeyPlaintext: secretKeyData.plaintext,
        keyPrefix: secretKey.keyPrefix,
        keyType: 'secret',
        status: 'active',
        permissions: [],
        role: chosenRole,
        legacy: false,
        minterUserId: userId,
        minterRole: gate.minterRole,
        lastUsedAt: null,
        createdAt: secretKey.createdAt,
      },
      publishableKey: {
        id: publishableKey.id,
        name: publishableKey.name,
        description: publishableKey.description,
        apiKeyPlaintext: publishableKeyData.plaintext,
        keyPrefix: publishableKey.keyPrefix,
        keyType: 'publishable',
        status: 'active',
        permissions: [],
        role: 'member',
        legacy: false,
        minterUserId: userId,
        minterRole: gate.minterRole,
        lastUsedAt: null,
        createdAt: publishableKey.createdAt,
      },
      message:
        'Key pair created successfully. Copy your secret key now - it will only be shown once!',
    }

    return { success: true, data: response }
  } catch (error) {
    console.error('Error in createApiKeyPair:', error)
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to create API key pair',
    }
  }
}

export interface KeyEndedResponse {
  message: string
  magicLinksEnded: number
  portalSessionsEnded: number
}

/**
 * Revoke (soft delete) an API key
 */
export async function revokeApiKey(
  keyId: string
): Promise<ActionResult<KeyEndedResponse>> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // The revoke door mirrors the mint door — MINT_KEY_ROLES,
    // so a finance user can revoke the finance-scoped keys they (or another
    // MINT_KEY_ROLES teammate) minted, not just create them.
    const gate = await assertKeyMinter()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify the API key belongs to this organization
    const existingKey = await db.api_keys.findFirst({
      where: {
        id: keyId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existingKey) {
      return { success: false, error: 'API key not found' }
    }

    // Key write and portal cascade in ONE transaction, key first —
    // if the cascade fails, the revoke rolls back rather than leaving a dead
    // key whose portal sessions quietly live on.
    const cascade = await db.$transaction(async (tx) => {
      await tx.api_keys.update({
        where: { id: keyId },
        data: {
          status: 'revoked',
          revokedAt: new Date(),
          apiKeyPlaintext: null, // Clear plaintext for security
          // ApiKeyLookupHash SURVIVES a revoke on purpose. status='revoked' is what blocks auth: every
          // validateApiKey lookup filters status:'active' — and the retained hash
          // is what lets the 401 path recognize the key and tell the caller it
          // was revoked instead of "invalid". Delete still erases the hash.
          updatedAt: new Date(),
        },
      })
      // Only a secret key can mint portal access (SecretKeyGuard on the mint
      // route), so a publishable revoke ends nothing.
      if (existingKey.keyType !== 'secret') {
        return { magicLinksEnded: 0, portalSessionsEnded: 0 }
      }
      return revokePortalAccessForOrg(tx, orgId)
    })

    return {
      success: true,
      data: {
        message:
          cascade.portalSessionsEnded > 0
            ? `API key revoked. Signed out ${cascade.portalSessionsEnded} active portal ${
                cascade.portalSessionsEnded === 1 ? 'session' : 'sessions'
              }.`
            : 'API key revoked successfully',
        ...cascade,
      },
    }
  } catch (error) {
    console.error('Error in revokeApiKey:', error)
    return {
      success: false,
      error:
        "The key wasn't revoked. A database write failed partway, so the whole change (the revoke and the portal sign-outs) was undone and the key still works. Try again in a moment.",
    }
  }
}

/**
 * Delete an API key permanently (soft delete via deletedAt)
 */
export async function deleteApiKey(
  keyId: string
): Promise<ActionResult<KeyEndedResponse>> {
  try {
    const session = await auth.api.getSession({ headers: await headers() })

    if (!session?.session?.activeOrganizationId) {
      return {
        success: false,
        error: 'Not authenticated or no active organization',
      }
    }

    // BUILD write: only owner/admin may delete an API key.
    const gate = await assertBuildManager()
    if (!gate.ok) return { success: false, error: gate.error }

    const orgId = session.session.activeOrganizationId

    // Verify the API key belongs to this organization
    const existingKey = await db.api_keys.findFirst({
      where: {
        id: keyId,
        organizationId: orgId,
        deletedAt: null,
      },
    })

    if (!existingKey) {
      return { success: false, error: 'API key not found' }
    }

    // Same key-then-cascade transaction as revokeApiKey — deleting a
    // secret key must end the org's portal access the same instant.
    const cascade = await db.$transaction(async (tx) => {
      await tx.api_keys.update({
        where: { id: keyId },
        data: {
          deletedAt: new Date(),
          apiKeyPlaintext: null, // Clear plaintext for security
          // Also null the deterministic lookup hash.
          // validateApiKey matches on apiKeyLookupHash FIRST, so a deleted key that
          // kept its hash + status='active' would re-authenticate. The verify path
          // filters deletedAt:null, and clearing the hash here is defense-in-depth:
          // a deleted credential has NO live lookup value left, mirroring how we clear
          // plaintext. Revoke keeps the hash and delete clears it on purpose: revoke
          // means "dead but recognizable" (the honest 401 can name the key), delete
          // means "erased". Deleting a revoked key downgrades its 401 back to the
          // generic message; that is the contract.
          apiKeyLookupHash: null,
          updatedAt: new Date(),
        },
      })
      if (existingKey.keyType !== 'secret') {
        return { magicLinksEnded: 0, portalSessionsEnded: 0 }
      }
      return revokePortalAccessForOrg(tx, orgId)
    })

    return {
      success: true,
      data: {
        message:
          cascade.portalSessionsEnded > 0
            ? `API key deleted. Signed out ${cascade.portalSessionsEnded} active portal ${
                cascade.portalSessionsEnded === 1 ? 'session' : 'sessions'
              }.`
            : 'API key deleted successfully',
        ...cascade,
      },
    }
  } catch (error) {
    console.error('Error in deleteApiKey:', error)
    return {
      success: false,
      error:
        "The key wasn't deleted. A database write failed partway, so the whole change (the delete and the portal sign-outs) was undone and the key still works. Try again in a moment.",
    }
  }
}
