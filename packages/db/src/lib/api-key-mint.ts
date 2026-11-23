/**
 * The shape of a freshly minted API key and of the api_keys row that stores
 * it. The dashboard's mint actions build from here, so every minted key has
 * the same row shape.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashApiKeyForLookup } from "./api-key-hash";

export type ApiKeyType = "secret" | "publishable";

export interface GeneratedApiKey {
  plaintext: string;
  hash: string;
  prefix: string;
}

export function generateApiKey(keyType: ApiKeyType): GeneratedApiKey {
  const keyTypePrefix = keyType === "publishable" ? "pk" : "sk";
  const prefix = `mf_${keyTypePrefix}_`;

  const randomPart = randomBytes(24).toString("base64url");
  const plaintext = `${prefix}${randomPart}`;
  const hash = createHash("sha256").update(plaintext).digest("hex");

  return { plaintext, hash, prefix };
}

export interface MintProvenance {
  minterUserId: string;
  minterRole: string;
}

// A type alias, not an interface, so it is assignable to a Prisma Json input.
export type MintedKeyPermissions = {
  role: string;
  minterUserId: string;
  minterRole: string;
};

export function mintedKeyPermissions(
  role: string,
  provenance: MintProvenance,
): MintedKeyPermissions {
  return {
    role,
    minterUserId: provenance.minterUserId,
    minterRole: provenance.minterRole,
  };
}

export const SECRET_PAIR_NAME_SUFFIX = " (Secret)";
export const SECRET_PAIR_DEFAULT_DESCRIPTION =
  "Server-side API key - never expose to frontend";

export interface SecretPairKeyInput extends MintProvenance {
  name: string;
  description?: string;
  organizationId: string;
  role: string;
  key: GeneratedApiKey;
  id?: string;
  now?: Date;
}

/**
 * The secret half of the dashboard's key pair. Secret keys are hash-only at
 * rest, so the plaintext is deliberately absent here.
 */
export function secretPairKeyCreateData(input: SecretPairKeyInput) {
  const now = input.now ?? new Date();
  return {
    id: input.id ?? randomUUID(),
    name: `${input.name.trim()}${SECRET_PAIR_NAME_SUFFIX}`,
    description: input.description?.trim() || SECRET_PAIR_DEFAULT_DESCRIPTION,
    organizationId: input.organizationId,
    createdById: input.minterUserId,
    apiKeyHash: input.key.hash,
    apiKeyLookupHash: hashApiKeyForLookup(input.key.plaintext),
    keyPrefix: input.key.prefix,
    keyType: "secret" as const,
    status: "active" as const,
    permissions: mintedKeyPermissions(input.role, input),
    createdAt: now,
    updatedAt: now,
  };
}
