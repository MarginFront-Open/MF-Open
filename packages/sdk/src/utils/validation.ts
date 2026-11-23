/**
 * Input Validation Utilities
 */

import { ValidationError } from "../errors";
import type { ServiceEntry, UsageRecord } from "../types";

/**
 * Validate that a required string field is present and non-empty
 */
export function validateRequired(value: unknown, fieldName: string): void {
  if (value === undefined || value === null || value === "") {
    throw new ValidationError(`${fieldName} is required`);
  }
}

/**
 * Validate that a number is non-negative
 */
export function validateNonNegative(value: number, fieldName: string): void {
  if (typeof value !== "number" || isNaN(value)) {
    throw new ValidationError(`${fieldName} must be a number`);
  }
  if (value < 0) {
    throw new ValidationError(`${fieldName} must be non-negative`);
  }
}

/**
 * Validate an ISO date string or Date object
 */
export function validateDateString(
  value: string | Date,
  fieldName: string,
): void {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid ISO date string`);
  }
}

/**
 * Validate a single ServiceEntry inside a multi-service record. The
 * label argument is the field path (e.g. "services[0]") so error
 * messages point to the right entry when one of N services is bad.
 */
export function validateServiceEntry(entry: ServiceEntry, label: string): void {
  if (entry === null || typeof entry !== "object") {
    throw new ValidationError(`${label} must be an object`);
  }
  validateRequired(entry.model, `${label}.model`);
  validateRequired(entry.modelProvider, `${label}.modelProvider`);
  if (entry.inputTokens !== undefined && entry.inputTokens !== null) {
    validateNonNegative(entry.inputTokens, `${label}.inputTokens`);
  }
  if (entry.outputTokens !== undefined && entry.outputTokens !== null) {
    validateNonNegative(entry.outputTokens, `${label}.outputTokens`);
  }
  if (entry.cacheReadTokens !== undefined && entry.cacheReadTokens !== null) {
    validateNonNegative(entry.cacheReadTokens, `${label}.cacheReadTokens`);
  }
  if (entry.cacheWriteTokens !== undefined && entry.cacheWriteTokens !== null) {
    validateNonNegative(entry.cacheWriteTokens, `${label}.cacheWriteTokens`);
  }
  if (entry.quantity !== undefined && entry.quantity !== null) {
    validateNonNegative(entry.quantity, `${label}.quantity`);
  }
}

/**
 * Validate a single usage record. Accepts either shape:
 *   - Single-service: top-level model + modelProvider (+ optional
 *     inputTokens / outputTokens / quantity).
 *   - Multi-service:  services[] array, each entry with its own
 *     model + modelProvider + volume fields.
 *
 * Rejects records that mix the two shapes (both `model` and
 * `services[]` provided) or that provide neither.
 *
 * Validation does NOT check whether a model is in MarginFront's
 * pricing catalog or whether volume is sufficient for cost
 * calculation — those are server-side concerns surfaced via
 * NEEDS_COST_BACKFILL or MISSING_VOLUME_DATA event statuses.
 */
export function validateUsageRecord(record: UsageRecord): void {
  if (record === null || typeof record !== "object") {
    throw new ValidationError("usage record must be an object");
  }

  // Common fields apply to both shapes.
  validateRequired(record.customerExternalId, "customerExternalId");
  validateRequired(record.agentCode, "agentCode");
  if (!record.signalName) {
    throw new ValidationError("signalName is required");
  }
  if (record.usageDate !== undefined) {
    validateDateString(record.usageDate, "usageDate");
  }

  // Detect shape. The discriminator is the presence of `services[]`.
  // We use bracket access here to read both branches off the union
  // without TS narrowing (the runtime check covers both).
  const r = record as unknown as {
    model?: unknown;
    modelProvider?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheWriteTokens?: unknown;
    quantity?: unknown;
    services?: unknown;
  };
  const hasServices = r.services !== undefined && r.services !== null;
  const hasModelOrProvider =
    (r.model !== undefined && r.model !== null && r.model !== "") ||
    (r.modelProvider !== undefined &&
      r.modelProvider !== null &&
      r.modelProvider !== "");

  if (!hasServices && !hasModelOrProvider) {
    throw new ValidationError(
      "Provide either model + modelProvider for a single-service event, " +
        "or services[] for multi-service. Got neither.",
    );
  }
  if (hasServices && hasModelOrProvider) {
    throw new ValidationError(
      "Cannot mix shapes: provide model + modelProvider OR services[], " +
        "not both. Pick model + modelProvider for one underlying service " +
        "(common case), or services[] when one business outcome is backed " +
        "by multiple services (e.g. an LLM call plus a Google Maps query).",
    );
  }

  if (hasServices) {
    // Multi-service path.
    if (!Array.isArray(r.services)) {
      throw new ValidationError("services must be an array");
    }
    if (r.services.length === 0) {
      throw new ValidationError(
        "services[] is empty. Add at least one entry, or use " +
          "model + modelProvider for a single-service event.",
      );
    }
    r.services.forEach((entry, index) => {
      validateServiceEntry(entry as ServiceEntry, `services[${index}]`);
    });
  } else {
    // Single-service path. r.model + r.modelProvider must both be present.
    validateRequired(r.model, "model");
    validateRequired(r.modelProvider, "modelProvider");
    if (r.inputTokens !== undefined && r.inputTokens !== null) {
      validateNonNegative(r.inputTokens as number, "inputTokens");
    }
    if (r.outputTokens !== undefined && r.outputTokens !== null) {
      validateNonNegative(r.outputTokens as number, "outputTokens");
    }
    if (r.cacheReadTokens !== undefined && r.cacheReadTokens !== null) {
      validateNonNegative(r.cacheReadTokens as number, "cacheReadTokens");
    }
    if (r.cacheWriteTokens !== undefined && r.cacheWriteTokens !== null) {
      validateNonNegative(r.cacheWriteTokens as number, "cacheWriteTokens");
    }
    if (r.quantity !== undefined && r.quantity !== null) {
      validateNonNegative(r.quantity as number, "quantity");
    }
  }
}

/**
 * Validate an array of usage records
 */
export function validateUsageRecords(records: UsageRecord[]): void {
  if (!Array.isArray(records)) {
    throw new ValidationError("records must be an array");
  }
  if (records.length === 0) {
    throw new ValidationError("records array cannot be empty");
  }
  records.forEach((record, index) => {
    try {
      validateUsageRecord(record);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ValidationError(
          `Invalid record at index ${index}: ${error.message}`,
        );
      }
      throw error;
    }
  });
}

/**
 * API key type
 */
export type ApiKeyType = "secret" | "publishable";

/**
 * Parsed API key information
 */
export interface ParsedApiKey {
  type: ApiKeyType;
}

/**
 * Conventional API key prefixes (cosmetic — used for display hints only, not access control)
 */
const KEY_PREFIXES = {
  secret: "mf_sk_",
  publishable: "mf_pk_",
} as const;

/**
 * Parse an API key prefix to infer a display hint for the key type.
 *
 * This is a convenience utility for UIs that want to show "secret" or
 * "publishable" based on the key prefix. The server is the authoritative
 * source of key validity and type — this function does NOT gate access.
 *
 * @returns ParsedApiKey with type hint, or null if prefix is unrecognized
 */
export function parseApiKey(apiKey: string): ParsedApiKey | null {
  if (!apiKey || typeof apiKey !== "string") {
    return null;
  }

  if (apiKey.startsWith(KEY_PREFIXES.secret)) {
    return { type: "secret" };
  }
  if (apiKey.startsWith(KEY_PREFIXES.publishable)) {
    return { type: "publishable" };
  }

  // Unknown prefix — return null but do NOT throw; the server decides validity
  return null;
}

/**
 * Check if an API key looks like a secret key based on its prefix.
 * Cosmetic hint only — the server is the authoritative source.
 */
export function isSecretKey(apiKey: string): boolean {
  const parsed = parseApiKey(apiKey);
  return parsed !== null && parsed.type === "secret";
}

/**
 * Check if an API key looks like a publishable key based on its prefix.
 * Cosmetic hint only — the server is the authoritative source.
 */
export function isPublishableKey(apiKey: string): boolean {
  const parsed = parseApiKey(apiKey);
  return parsed !== null && parsed.type === "publishable";
}

/**
 * Validate that an API key is present and non-empty.
 * Prefix format is NOT validated — the server decides if the key is valid.
 *
 * @throws ValidationError if key is missing or not a string
 */
export function validateApiKey(apiKey: string): void {
  if (!apiKey || typeof apiKey !== "string") {
    throw new ValidationError("API key is required");
  }
}

/**
 * @deprecated The server enforces key type — client-side prefix checks are not reliable.
 * This function does nothing.
 */
export function assertSecretKey(_apiKey: string): void {
  // no-op: the server will reject with a clear error if a publishable key
  // attempts a secret-only operation
}
