/**
 * Usage Resource
 * Handles usage tracking and event recording
 */

import type { HttpClient } from "../utils/http";
import type { RetryBuffer } from "../utils/buffer";
import type { WarnSink } from "../utils/warn-logger";
import { isAuthFailure, ValidationError } from "../errors";
import type {
  UsageRecord,
  UsageRecordResponse,
  TrackEventParams,
  TrackEventResponse,
  SingleEventResponse,
  BatchEventResponse,
} from "../types";
import { validateUsageRecord, validateUsageRecords } from "../utils/validation";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resource for recording usage events
 */
export class UsageResource {
  private readonly pendingAuthDropCounts = new Map<string, number>();

  constructor(
    private readonly http: HttpClient,
    private readonly fireAndForget: boolean = true,
    private readonly buffer: RetryBuffer | null = null,
    private readonly logger: WarnSink = {
      warn: (msg, data) => console.warn(`[MarginFront] ${msg}`, data ?? ""),
    },
  ) {}

  /**
   * Track events for a customer - supports both single record and batch operations
   */
  async trackEvent(params: TrackEventParams): Promise<TrackEventResponse> {
    // Check if this is a batch operation
    if ("records" in params) {
      const records = params.records.map((record) =>
        this.normalizeRecord(record),
      );

      try {
        validateUsageRecords(records);
      } catch (error) {
        if (this.fireAndForget && error instanceof ValidationError) {
          this.logger.warn(
            `Validation failed, event(s) dropped: ${error.message}`,
          );
          return this.convertToBatchResponse(
            this.undeliveredResponse(records, error.message, 0),
            false,
          );
        }
        throw error;
      }

      try {
        const response = await this.http.post<UsageRecordResponse>(
          "/usage/record",
          {
            records,
          },
        );
        this.buffer?.noteDeliverySuccess();
        return this.convertToBatchResponse(response, true);
      } catch (error) {
        if (this.fireAndForget) {
          const buffered = this.handleSendFailure(records, error);
          return this.convertToBatchResponse(
            this.undeliveredResponse(records, describeError(error), buffered),
            false,
          );
        }
        throw error;
      }
    }

    // Single record
    const record = this.normalizeRecord(params);

    try {
      validateUsageRecord(record);
    } catch (error) {
      if (this.fireAndForget && error instanceof ValidationError) {
        this.logger.warn(`Validation failed, event dropped: ${error.message}`);
        return {
          id: "",
          success: false,
          delivered: false,
          buffered: 0,
          error: error.message,
        };
      }
      throw error;
    }

    try {
      const response = await this.http.post<UsageRecordResponse>(
        "/usage/record",
        {
          records: [record],
        },
      );
      this.buffer?.noteDeliverySuccess();

      // For single record, return SingleEventResponse format
      if (response.results.success.length === 1) {
        const successResult = response.results.success[0];
        return {
          id: successResult.eventId,
          success: true,
          delivered: true,
          eventId: successResult.eventId,
          rawEventId: successResult.rawEventId,
          timestamp: successResult.timestamp,
          created: successResult.created,
        };
      }

      return this.convertToBatchResponse(response, true);
    } catch (error) {
      if (this.fireAndForget) {
        const buffered = this.handleSendFailure([record], error);
        return {
          id: "",
          success: false,
          delivered: false,
          buffered,
          error: describeError(error),
        };
      }
      throw error;
    }
  }

  /**
   * Record a single usage event
   */
  async record(record: UsageRecord): Promise<UsageRecordResponse> {
    const normalizedRecord = this.normalizeRecord(record);

    try {
      validateUsageRecord(normalizedRecord);
    } catch (error) {
      if (this.fireAndForget && error instanceof ValidationError) {
        this.logger.warn(`Validation failed, event dropped: ${error.message}`);
        return this.undeliveredResponse([normalizedRecord], error.message, 0);
      }
      throw error;
    }

    try {
      const response = await this.http.post<UsageRecordResponse>(
        "/usage/record",
        {
          records: [normalizedRecord],
        },
      );
      this.buffer?.noteDeliverySuccess();
      return { ...response, delivered: true };
    } catch (error) {
      if (this.fireAndForget) {
        const buffered = this.handleSendFailure([normalizedRecord], error);
        return this.undeliveredResponse(
          [normalizedRecord],
          describeError(error),
          buffered,
        );
      }
      throw error;
    }
  }

  /**
   * Record multiple usage events in a batch
   */
  async recordBatch(records: UsageRecord[]): Promise<UsageRecordResponse> {
    const normalizedRecords = records.map((record) =>
      this.normalizeRecord(record),
    );

    try {
      validateUsageRecords(normalizedRecords);
    } catch (error) {
      if (this.fireAndForget && error instanceof ValidationError) {
        this.logger.warn(
          `Validation failed, event(s) dropped: ${error.message}`,
        );
        return this.undeliveredResponse(normalizedRecords, error.message, 0);
      }
      throw error;
    }

    try {
      const response = await this.http.post<UsageRecordResponse>(
        "/usage/record",
        {
          records: normalizedRecords,
        },
      );
      this.buffer?.noteDeliverySuccess();
      return { ...response, delivered: true };
    } catch (error) {
      if (this.fireAndForget) {
        const buffered = this.handleSendFailure(normalizedRecords, error);
        return this.undeliveredResponse(
          normalizedRecords,
          describeError(error),
          buffered,
        );
      }
      throw error;
    }
  }

  /**
   * Route a failed send: auth failures (401/403) drop immediately with a
   * warning naming the key as the cause (no retry can fix a dead key), while
   * everything else goes to the retry buffer. Returns how many records were
   * buffered.
   */
  private handleSendFailure(records: UsageRecord[], error: unknown): number {
    if (isAuthFailure(error)) {
      this.warnAuthDrop(records.length, error);
      this.buffer?.noteAuthDrop(records.length);
      return 0;
    }
    return this.bufferRecords(records);
  }

  // Warns at most once per 60s per status code. Drops suppressed inside the
  // window are carried into the next emitted message, so the count a customer
  // reads is the full loss since the last warning, not just this call's.
  private warnAuthDrop(count: number, error: unknown): void {
    const status = (error as { statusCode?: number }).statusCode;
    const key = `auth-drop:${status}`;
    const total = (this.pendingAuthDropCounts.get(key) ?? 0) + count;
    const message = this.authDropMessage(status, total, error);
    if (this.logger.warnThrottled) {
      const emitted = this.logger.warnThrottled(key, message);
      this.pendingAuthDropCounts.set(key, emitted ? 0 : total);
    } else {
      this.logger.warn(message);
    }
  }

  private authDropMessage(
    status: number | undefined,
    count: number,
    error: unknown,
  ): string {
    const droppedClause = `${count} event(s) were dropped, not retried`;
    if (status === 403) {
      const err = error as { requiredRoles?: unknown; keyRole?: unknown };
      // parseApiError always writes the requiredRoles KEY (undefined value on
      // non-role 403s), so branch on the value's shape, never with `in`.
      if (Array.isArray(err.requiredRoles) && err.requiredRoles.length > 0) {
        return `MarginFront refused to record usage with this API key (HTTP 403), so ${droppedClause}. This key's role ('${String(err.keyRole)}') can't record usage. Allowed roles: ${err.requiredRoles.join(", ")}. Create a key with an allowed role in your MarginFront dashboard under Build, then API keys, and restart the client.`;
      }
      return `MarginFront refused to record usage with this API key (HTTP 403), so ${droppedClause}. Publishable keys (mf_pk_...) can read but can't record usage. Restart the client with a secret key (mf_sk_...).`;
    }
    return `MarginFront rejected this API key (HTTP 401), so ${droppedClause}. The key's usually been revoked, rotated, or taken from the wrong environment. Open your MarginFront dashboard under Build, then API keys, and restart the client with a working secret key (mf_sk_...).`;
  }

  /**
   * Build the honest response for records that never reached the server:
   * every record is a failed row, delivered is false, and buffered reports
   * what the retry buffer actually accepted (0 for validation and auth
   * drops).
   */
  private undeliveredResponse(
    records: UsageRecord[],
    error: string,
    buffered: number,
  ): UsageRecordResponse {
    return {
      processed: records.length,
      successful: 0,
      failed: records.length,
      delivered: false,
      buffered,
      results: {
        success: [],
        failed: records.map((record) => ({ record, error, stored: false })),
      },
    };
  }

  /**
   * Push failed records into the retry buffer (if one exists) and report how
   * many the buffer actually kept.
   */
  private bufferRecords(records: UsageRecord[]): number {
    if (!this.buffer) return 0;
    let accepted = 0;
    for (const record of records) {
      if (this.buffer.push(record)) {
        accepted++;
      }
    }
    // A batch larger than the buffer cap evicts its own oldest entries, so
    // only the ones still present count as buffered.
    const stillBuffered = Math.min(accepted, this.buffer.size);
    this.logger.warn(
      `${stillBuffered} event(s) queued for retry (buffer size: ${this.buffer.size})`,
    );
    return stillBuffered;
  }

  /**
   * Normalize a usage record
   */
  private normalizeRecord(record: UsageRecord): UsageRecord {
    const normalized: UsageRecord = { ...record };

    // Default quantity to 1 only on single-service shape. Multi-service
    // events carry per-service quantities inside `services[]`; the
    // top-level record has no `quantity` field on that branch.
    if (!("services" in normalized)) {
      if (normalized.quantity === undefined) {
        normalized.quantity = 1;
      }
    }

    // Convert Date objects to ISO strings
    if (normalized.usageDate instanceof Date) {
      normalized.usageDate = normalized.usageDate.toISOString();
    }

    return normalized;
  }

  /**
   * Convert native response to BatchEventResponse format. `delivered` is true
   * only when `response` came from an actual server reply.
   */
  private convertToBatchResponse(
    response: UsageRecordResponse,
    delivered: boolean,
  ): BatchEventResponse {
    return {
      success: delivered && response.failed === 0,
      totalRecords: response.processed,
      successCount: response.successful,
      failureCount: response.failed,
      buffered: response.buffered,
      results: [
        ...response.results.success.map((result) => ({
          success: true,
          delivered,
          responseData: {
            id: result.eventId,
            success: true,
            delivered,
            eventId: result.eventId,
            rawEventId: result.rawEventId,
            timestamp: result.timestamp,
            created: result.created,
          } satisfies SingleEventResponse,
        })),
        ...response.results.failed.map((result) => ({
          success: false,
          delivered,
          error: result.error,
          code: result.code,
          stored: result.stored,
          eventId: result.eventId,
          rawEventId: result.rawEventId,
          created: result.created,
          originalData: result.record as unknown as Record<string, unknown>,
        })),
      ],
    };
  }
}
