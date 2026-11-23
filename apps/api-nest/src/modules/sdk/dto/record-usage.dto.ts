import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsString,
  IsInt,
  IsNumber,
  IsOptional,
  IsDateString,
  IsObject,
  IsIn,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import { maxContainerDepth } from '../../../common/utils/ingest-body-limit';

export const USAGE_ENVIRONMENTS = ['production', 'staging', 'development', 'testing'] as const;
export type UsageEnvironment = (typeof USAGE_ENVIRONMENTS)[number];

// Ingest caps. Each cap sits well above the longest value a real caller
// sends for that field.
export const INGEST_STRING_MAX_LENGTH = 255;
// modelProvider persists to signal_event_services.modelProvider VarChar(100)
// (schema.prisma); a looser DTO cap would pass validation then fail at insert.
export const MODEL_PROVIDER_MAX_LENGTH = 100;
export const METADATA_MAX_BYTES = 16_384;
export const METADATA_MAX_DEPTH = 5;
export const SERVICES_MAX_SIZE = 100;
// Absurd-value ceiling on every numeric ingest field. 50M tokens is
// ~a full day of nonstop top-tier agents, so a real caller never reaches it; a value
// past the cap is a data error (wrong units, a flipped sentinel like -1, a runaway
// loop) that would otherwise price into one giant bogus charge. Applies to both the
// single-service (UsageRecordDto) and per-service (ServiceEntryDto) numeric fields.
export const NUMERIC_FIELD_MAX = 50_000_000;

function tooLongMessage(field: string, limit: number): string {
  return (
    `${field} is too long: the limit is ${limit} characters. ` +
    `Shorten the ${field} value and resend the request.`
  );
}

function tooLargeNumberMessage(field: string, limit: number): string {
  return (
    `${field} is too large: the limit is ${limit}. A value this big is almost ` +
    `always a data error (wrong units, or a placeholder). Check the ${field} value ` +
    `and resend the request.`
  );
}

/**
 * Explicit metadata caps at the trust boundary: serialized size
 * ≤ METADATA_MAX_BYTES and nesting ≤ METADATA_MAX_DEPTH, validated here rather
 * than inherited from body-parser defaults. Shape (must be an object) stays
 * with @IsObject; this decorator only measures.
 */
function IsMetadataWithinLimits(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isMetadataWithinLimits',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === null || typeof value !== 'object') return true;
          if (maxContainerDepth(value) > METADATA_MAX_DEPTH) return false;
          return Buffer.byteLength(JSON.stringify(value), 'utf8') <= METADATA_MAX_BYTES;
        },
        defaultMessage(args: ValidationArguments) {
          const value = args.value;
          if (
            value !== null &&
            typeof value === 'object' &&
            maxContainerDepth(value) > METADATA_MAX_DEPTH
          ) {
            return (
              `metadata is nested ${maxContainerDepth(value)} levels deep: the limit is ` +
              `${METADATA_MAX_DEPTH}. Flatten metadata so objects and arrays nest at most ` +
              `${METADATA_MAX_DEPTH} levels.`
            );
          }
          return (
            `metadata is too large: the limit is ${METADATA_MAX_BYTES} bytes (16 KB) when ` +
            `serialized. Trim metadata, or store bulky context in your own system and ` +
            `reference it by ID.`
          );
        },
      },
    });
  };
}

/**
 * One service inside a multi-service event. Mirrors the SDK's
 * `ServiceEntry` interface (packages/sdk/src/types.ts) field-for-field.
 *
 * A single user-visible event ("report 42 generated") can be backed by
 * N service costs (e.g. Claude tokens + Google Maps queries). Each
 * entry in `UsageRecordDto.services` becomes one `signal_event_services`
 * child row tied to the parent `signal_events` row. The parent's
 * usageCost is the sum of resolved children, or null if any child is
 * unresolved.
 */
export class ServiceEntryDto {
  @ApiProperty({
    description:
      'Model identifier from your provider for this specific service. ' +
      'Same shape as the top-level `model` field on a single-service event. ' +
      'Examples: "claude-sonnet-4-6", "gpt-4o", "google-maps-places", "twilio-sms".',
    maxLength: INGEST_STRING_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(INGEST_STRING_MAX_LENGTH, {
    message: tooLongMessage('model', INGEST_STRING_MAX_LENGTH),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  model: string;

  @ApiProperty({
    description:
      'Provider name in lowercase for this specific service. ' +
      'Examples: "anthropic", "openai", "google", "twilio".',
    maxLength: MODEL_PROVIDER_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(MODEL_PROVIDER_MAX_LENGTH, {
    message: tooLongMessage('modelProvider', MODEL_PROVIDER_MAX_LENGTH),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  modelProvider: string;

  @ApiPropertyOptional({
    description:
      'Number of input (prompt) tokens for this service. Required for LLM ' +
      'services (costUnit "1M tokens"); omit for non-LLM services. Missing ' +
      'volume is non-fatal: the parent event lands with eventStatus = ' +
      'MISSING_VOLUME_DATA until backfilled.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('inputTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  inputTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of output (completion) tokens for this service. Required for ' +
      'LLM services. Missing volume is non-fatal (MISSING_VOLUME_DATA).',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('outputTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  outputTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of prompt-cache READ tokens (cache hits) for this LLM service. ' +
      'Optional and additive — pass the cache-read count from your provider response ' +
      '(Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`). ' +
      'Priced at the much cheaper cache-read rate, not the input rate. Omit if unknown.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('cacheReadTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  cacheReadTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of prompt-cache WRITE tokens (cache creation) for this LLM service. ' +
      'Optional and additive — pass the cache-creation count from your provider response ' +
      '(Anthropic `cache_creation_input_tokens`). Priced at the cache-write rate. ' +
      'Omit if unknown.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('cacheWriteTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  cacheWriteTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of billing units for non-LLM services (e.g. Textract pages, ' +
      'Twilio SMS, Google Maps queries). Service-level quantity. The ' +
      'top-level `quantity` on the parent record stays signal-level (one ' +
      'report = quantity 1, regardless of how many services it called).',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('quantity', NUMERIC_FIELD_MAX) })
  @IsOptional()
  quantity?: number;
}

/**
 * Class-level validator that enforces the either-or shape rule on
 * UsageRecordDto: provide model + modelProvider for a single-service
 * event, OR provide services[] for a multi-service event. Reject
 * if both are present (ambiguous) and reject if neither is present
 * (no way to look up cost).
 *
 * Mirrors the SDK validator in packages/sdk/src/utils/validation.ts
 * so server-side rejection messages line up with what the SDK already
 * tells the user before the request leaves their app.
 */
function IsExactlyOneShape(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isExactlyOneShape',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments) {
          const obj = args.object as {
            model?: unknown;
            modelProvider?: unknown;
            services?: unknown;
          };
          const hasServices = obj.services !== undefined && obj.services !== null;
          const hasSingle =
            (obj.model !== undefined && obj.model !== null && obj.model !== '') ||
            (obj.modelProvider !== undefined &&
              obj.modelProvider !== null &&
              obj.modelProvider !== '');
          if (!hasServices && !hasSingle) return false;
          if (hasServices && hasSingle) return false;
          return true;
        },
        defaultMessage(args: ValidationArguments) {
          const obj = args.object as {
            model?: unknown;
            modelProvider?: unknown;
            services?: unknown;
          };
          const hasServices = obj.services !== undefined && obj.services !== null;
          const hasSingle =
            (obj.model !== undefined && obj.model !== null && obj.model !== '') ||
            (obj.modelProvider !== undefined &&
              obj.modelProvider !== null &&
              obj.modelProvider !== '');
          if (hasServices && hasSingle) {
            return (
              'Cannot mix shapes: provide model + modelProvider OR services[], ' +
              'not both. Pick model + modelProvider for one underlying service ' +
              '(common case), or services[] when one business outcome is backed ' +
              'by multiple services (e.g. an LLM call plus a Google Maps query).'
            );
          }
          return (
            'Provide either model + modelProvider for a single-service event, ' +
            'or services[] for multi-service. Got neither.'
          );
        },
      },
    });
  };
}

export class UsageRecordDto {
  @ApiProperty({ description: 'Customer external ID', maxLength: INGEST_STRING_MAX_LENGTH })
  @IsString()
  @MaxLength(INGEST_STRING_MAX_LENGTH, {
    message: tooLongMessage('customerExternalId', INGEST_STRING_MAX_LENGTH),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  customerExternalId: string;

  @ApiProperty({
    description: 'Agent code (external ID set in the UI)',
    maxLength: INGEST_STRING_MAX_LENGTH,
  })
  @IsString()
  @MaxLength(INGEST_STRING_MAX_LENGTH, {
    message: tooLongMessage('agentCode', INGEST_STRING_MAX_LENGTH),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  agentCode: string;

  @ApiProperty({ description: 'Signal name', maxLength: INGEST_STRING_MAX_LENGTH })
  @IsString()
  @MaxLength(INGEST_STRING_MAX_LENGTH, {
    message: tooLongMessage('signalName', INGEST_STRING_MAX_LENGTH),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  signalName: string;

  @ApiPropertyOptional({
    description:
      'Model identifier from your provider. Pass whatever your provider SDK returned: ' +
      '`response.model` from OpenAI/Anthropic, `response.modelVersion` from Gemini, or ' +
      'the service SKU for non-LLM tools. Examples: "gpt-4o", "claude-sonnet-4-6", ' +
      '"gemini-2.0-flash-001", "twilio-sms". Case-insensitive; whitespace is trimmed. ' +
      'Required when `services` is absent (single-service shape). Omit when sending ' +
      '`services[]` for a multi-service event.',
    maxLength: INGEST_STRING_MAX_LENGTH,
  })
  @ValidateIf((o) => o.services === undefined || o.services === null)
  @IsString()
  @MaxLength(INGEST_STRING_MAX_LENGTH, {
    message: tooLongMessage('model', INGEST_STRING_MAX_LENGTH),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  model?: string;

  @ApiPropertyOptional({
    description:
      'Provider name in lowercase. Identifies which pricing table rows this event should ' +
      'match against. Examples: "openai", "anthropic", "google", "twilio", "aws". ' +
      'Required when `services` is absent. The provider is never inferred from the ' +
      'model string, because cross-provider collisions would bill against the ' +
      'wrong rates. Omit when sending `services[]` for a multi-service event.',
    maxLength: MODEL_PROVIDER_MAX_LENGTH,
  })
  @ValidateIf((o) => o.services === undefined || o.services === null)
  @IsString()
  @MaxLength(MODEL_PROVIDER_MAX_LENGTH, {
    message: tooLongMessage('modelProvider', MODEL_PROVIDER_MAX_LENGTH),
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  modelProvider?: string;

  @ApiPropertyOptional({
    description:
      'Number of input (prompt) tokens. Conditionally required: must be provided when ' +
      'the model is an LLM (costUnit = "1M tokens"). Omit for non-LLM services — those ' +
      'use quantity instead. If missing for an LLM model, the event is stored but cost ' +
      'cannot be calculated (status: MISSING_VOLUME_DATA). Single-service shape only — ' +
      'use `services[].inputTokens` for multi-service.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('inputTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  inputTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of output (completion) tokens. Conditionally required: must be provided ' +
      'when the model is an LLM (costUnit = "1M tokens"). If missing for an LLM model, ' +
      'the event is stored but cost cannot be calculated (status: MISSING_VOLUME_DATA). ' +
      'Single-service shape only.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('outputTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  outputTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of prompt-cache READ tokens (cache hits). Optional, additive, LLM-only. ' +
      'Pass the cache-read count from your provider response (Anthropic `cache_read_input_tokens`, ' +
      'OpenAI `prompt_tokens_details.cached_tokens`). Priced at the cheaper cache-read rate. ' +
      'Single-service shape only — use `services[].cacheReadTokens` for multi-service.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('cacheReadTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  cacheReadTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of prompt-cache WRITE tokens (cache creation). Optional, additive, LLM-only. ' +
      'Pass the cache-creation count from your provider response (Anthropic ' +
      '`cache_creation_input_tokens`). Priced at the cache-write rate. Single-service shape only.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('cacheWriteTokens', NUMERIC_FIELD_MAX) })
  @IsOptional()
  cacheWriteTokens?: number;

  @ApiPropertyOptional({
    description:
      'Number of billing units. Conditionally required: must be provided when the model ' +
      'is a non-LLM service (e.g. Textract pages, Twilio SMS, DALL-E images). Defaults ' +
      'to 1 for LLM events. If missing for a non-LLM service, the event is stored but ' +
      'cost cannot be calculated (status: MISSING_VOLUME_DATA). Top-level quantity stays ' +
      'signal-level (one report = quantity 1) — for service-level quantities in a ' +
      'multi-service event, use `services[].quantity`.',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  @Max(NUMERIC_FIELD_MAX, { message: tooLargeNumberMessage('quantity', NUMERIC_FIELD_MAX) })
  @IsOptional()
  quantity?: number;

  @ApiPropertyOptional({
    description:
      'Multi-service shape: one event from the user perspective ("report 42 generated") ' +
      'backed by N underlying services (e.g. Claude tokens + a Google Maps query). ' +
      'When present, omit the top-level `model` / `modelProvider` / volume fields — each ' +
      'service entry carries its own. Each entry becomes one `signal_event_services` ' +
      'child row. Parent usageCost is the sum of resolved children (or null if any ' +
      'child is unresolved). 1-100 entries.',
    type: [ServiceEntryDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, {
    message:
      'services[] is empty. Add at least one entry, or use ' +
      'model + modelProvider for a single-service event.',
  })
  @ArrayMaxSize(SERVICES_MAX_SIZE, {
    message:
      `services[] has more than ${SERVICES_MAX_SIZE} entries: the limit is ` +
      `${SERVICES_MAX_SIZE} services per record. Split the extra services across ` +
      `additional records.`,
  })
  @ValidateNested({ each: true })
  @Type(() => ServiceEntryDto)
  services?: ServiceEntryDto[];

  @ApiPropertyOptional({ description: 'Usage date (ISO format)' })
  @IsDateString()
  @IsOptional()
  usageDate?: string;

  @ApiPropertyOptional({
    description:
      'Additional metadata. Limits: 16 KB serialized, objects/arrays nested at ' +
      'most 5 levels deep.',
  })
  @IsObject()
  @IsMetadataWithinLimits()
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'Environment the event occurred in. Drives the COGS vs R&D accounting ' +
      'classification: `production` events flow into COGS, `development` and ' +
      '`testing` flow into R&D. `staging` is intentionally ambiguous — the ' +
      "platform leaves the signal's `costCategory` untouched. When omitted, " +
      'the platform falls back to whatever the signal is already classified as.',
    enum: USAGE_ENVIRONMENTS,
  })
  @IsOptional()
  @IsIn(USAGE_ENVIRONMENTS as unknown as string[])
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  environment?: UsageEnvironment;

  @ApiPropertyOptional({
    description:
      'Client-supplied idempotency key for exactly-once ingest. A ' +
      'repeat POST carrying the same key (scoped to your org) is treated as a ' +
      'no-op replay: no duplicate event is created and the response returns the ' +
      'ORIGINAL event id + cost. Use a stable per-turn value (e.g. a hash of the ' +
      'underlying telemetry line) so a forwarder restart or retry-after-failure ' +
      "can't double-count. Optional — omit it for plain at-least-once delivery; a " +
      'missing key never dedups (two keyless events both land). Max 255 chars.',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(INGEST_STRING_MAX_LENGTH, {
    message: tooLongMessage('idempotencyKey', INGEST_STRING_MAX_LENGTH),
  })
  idempotencyKey?: string;

  /**
   * Sentinel field for the class-level either-or shape check. Not
   * serialized; never read by callers. Triggers IsExactlyOneShape
   * during validation so we can emit one clean error message when
   * a record provides both shapes or neither.
   */
  @IsExactlyOneShape()
  protected readonly __shapeSentinel?: never;
}

export class RecordUsageDto {
  @ApiProperty({
    description: 'Array of usage records (1-100 items)',
    type: [UsageRecordDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UsageRecordDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  records: UsageRecordDto[];
}
