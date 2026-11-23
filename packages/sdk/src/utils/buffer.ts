/**
 * Retry Buffer
 *
 * Holds failed usage events in memory and retries them in the background.
 * Only active when there are events to retry — zero overhead when everything
 * is working fine.
 *
 * Give-up policy:
 *   - Max 5 attempts per event, then drop with a warning.
 *   - Backoff between flushes: 10s → 20s → 40s → 60s ceiling. Resets on success.
 *   - Buffer cap: 1,000 events. Oldest drop when full.
 *   - Auth failures (401/403) are counted separately: they consume no delivery
 *     attempt and never escalate backoff. A record drops only after failing
 *     auth on two flushes in a row; any resolved send clears every auth
 *     strike. A lone 401 can be a server-side fault dressed as an auth
 *     error, so one is never proof of a dead key.
 *
 * Flush outcome policy:
 *   - A response with `stored: false` failed rows re-queues exactly those
 *     records (attempts preserved) and escalates backoff.
 *   - `stored: true` failed rows are already ingested server-side — warned,
 *     never re-queued (a retry would double-bill).
 *   - A failed row with `stored` absent is treated as stored — double-ingest
 *     is the worse failure — and warned distinctly.
 *   - Only a fully-clean flush (no failed rows) resets the backoff interval.
 *   - A missing or shapeless response counts as fully clean, so flush never
 *     throws on sendFns that resolve with nothing.
 */

import { isAuthFailure } from "../errors";
import type {
  UsageRecord,
  UsageRecordFailure,
  UsageRecordResponse,
} from "../types";
import type { WarnSink } from "./warn-logger";

const MAX_BUFFER_SIZE = 1000;
const MAX_ATTEMPTS = 5;
const BASE_FLUSH_INTERVAL_MS = 10_000;
const MAX_FLUSH_INTERVAL_MS = 60_000;

interface BufferedRecord {
  record: UsageRecord;
  attempts: number;
  authFailures: number;
}

// The server echoes failed records through a DTO layer that can reorder keys,
// so equality has to ignore key order.
function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[key] = (val as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return val;
  });
}

function extractFailedRows(response: unknown): UsageRecordFailure[] {
  if (!response || typeof response !== "object") return [];
  const failed = (response as { results?: { failed?: unknown } }).results
    ?.failed;
  return Array.isArray(failed) ? (failed as UsageRecordFailure[]) : [];
}

export class RetryBuffer {
  private buffer: BufferedRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentIntervalMs = BASE_FLUSH_INTERVAL_MS;
  private destroying = false;
  private flushInFlight = false;
  private authDroppedSinceRecovery = 0;

  constructor(
    private readonly sendFn: (
      records: UsageRecord[],
    ) => Promise<UsageRecordResponse | undefined | void>,
    private readonly logger: WarnSink,
  ) {
    // Best-effort flush when the Node process is about to exit. Events still
    // in the buffer after a hard crash are lost (in-memory only).
    if (typeof process !== "undefined" && typeof process.on === "function") {
      process.on("beforeExit", () => {
        if (this.buffer.length > 0) {
          this.flush().catch(() => {});
        }
      });
    }
  }

  // Add a failed event to the buffer. Starts the flush timer if it isn't
  // already running. Returns whether the buffer accepted the event.
  push(record: UsageRecord): boolean {
    if (this.destroying) return false;

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      const dropped = this.buffer.shift();
      this.logger.warn(
        `RetryBuffer full (${MAX_BUFFER_SIZE} events), dropping oldest event`,
        { droppedRecord: dropped?.record },
      );
    }

    this.buffer.push({ record, attempts: 0, authFailures: 0 });
    this.ensureTimer();
    return true;
  }

  // Register events dropped at send time because the key was rejected, so the
  // recovery message can report the full loss when delivery resumes.
  noteAuthDrop(count: number): void {
    this.authDroppedSinceRecovery += count;
  }

  // Any successful delivery proves the key is alive, including direct sends
  // that never touched this buffer (UsageResource calls this on its success
  // paths). Clears every pending auth strike and reports what was lost.
  noteDeliverySuccess(): void {
    for (const entry of this.buffer) {
      entry.authFailures = 0;
    }
    this.reportRecovery();
  }

  get size(): number {
    return this.buffer.length;
  }

  // Try to send everything in the buffer. Called by the timer and also
  // available for manual use in tests. Overlapping calls (timer + beforeExit
  // + manual) collapse into one: a second concurrent flush is a no-op, so a
  // single auth fault can never count as two strikes.
  async flush(): Promise<void> {
    if (this.flushInFlight) return;
    this.flushInFlight = true;
    try {
      await this.flushOnce();
    } finally {
      this.flushInFlight = false;
    }
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;

    // Take the in-flight entries out of the buffer so records pushed while
    // the send is awaiting are neither cleared nor re-sent by this flush.
    const inFlight = this.buffer;
    this.buffer = [];

    for (const entry of inFlight) {
      entry.attempts++;
    }
    const records = inFlight.map((e) => e.record);

    let response: UsageRecordResponse | undefined | void;
    try {
      response = await this.sendFn(records);
    } catch (error) {
      if (this.destroying) return;
      if (isAuthFailure(error)) {
        this.handleAuthFailure(inFlight, error);
      } else {
        // A non-auth fault between two 401s restarts the auth count:
        // "two in a row" means literally consecutive.
        for (const entry of inFlight) {
          entry.authFailures = 0;
        }
        this.requeueAfterFailure(inFlight);
      }
      this.settleTimer();
      return;
    }

    if (this.destroying) return;

    // The send resolved, so the key is alive. Even a response carrying failed
    // rows proves auth works, which is why this sits before the row handling.
    for (const entry of inFlight) {
      entry.authFailures = 0;
    }
    this.noteDeliverySuccess();

    const failedRows = extractFailedRows(response);
    if (failedRows.length === 0) {
      this.currentIntervalMs = BASE_FLUSH_INTERVAL_MS;
      this.settleTimer();
      return;
    }

    const unmatched = [...inFlight];
    const toRequeue: BufferedRecord[] = [];

    for (const row of failedRows) {
      if (row.stored === undefined) {
        this.logger.warn(
          `Event failed without a stored flag — treating as stored and NOT retrying (a retry could double-bill)`,
          { record: row.record, error: row.error },
        );
        continue;
      }

      if (row.stored) {
        this.logger.warn(
          `Event was stored but flagged by the server (${row.code ?? "no code"}) — not retried`,
          { record: row.record, error: row.error, eventId: row.eventId },
        );
        continue;
      }

      if (!row.record) {
        this.logger.warn(
          `Server reported an unstored failure without a record echo — nothing to re-queue`,
          { error: row.error },
        );
        continue;
      }

      const rowKey = stableSerialize(row.record);
      const matchIndex = unmatched.findIndex(
        (entry) => stableSerialize(entry.record) === rowKey,
      );
      if (matchIndex >= 0) {
        const [entry] = unmatched.splice(matchIndex, 1);
        toRequeue.push(entry);
      } else {
        this.logger.warn(
          `Server reported an unstored failure the buffer could not correlate — re-queuing the server's echo`,
          { record: row.record, error: row.error },
        );
        toRequeue.push({ record: row.record, attempts: 1, authFailures: 0 });
      }
    }

    if (toRequeue.length > 0) {
      this.requeueAfterFailure(toRequeue);
    }
    this.settleTimer();
  }

  // Stop the timer and clear the buffer. Called when the SDK client is
  // destroyed or the process is shutting down.
  destroy(): void {
    this.destroying = true;
    this.stopTimer();
    this.buffer = [];
  }

  private handleAuthFailure(inFlight: BufferedRecord[], error: unknown): void {
    const status = (error as { statusCode?: number }).statusCode;
    const held: BufferedRecord[] = [];
    const dropped: BufferedRecord[] = [];

    for (const entry of inFlight) {
      // Roll back the pre-send attempts++: an auth failure must not burn a
      // delivery attempt, or five 401s would still destroy the queue through
      // the MAX_ATTEMPTS path. Auth fate is decided by authFailures alone.
      entry.attempts--;
      entry.authFailures++;
      if (entry.authFailures >= 2) {
        dropped.push(entry);
      } else {
        held.push(entry);
      }
    }

    if (dropped.length > 0) {
      this.authDroppedSinceRecovery += dropped.length;
      this.logger.warn(
        `MarginFront rejected this API key (HTTP ${status}) twice in a row, so ${dropped.length} held event(s) were dropped and can't be recovered. The key's usually been revoked, rotated, or taken from the wrong environment. Open your MarginFront dashboard under Build, then API keys, and restart the client with a working secret key (mf_sk_...).`,
        { droppedRecords: dropped.map((entry) => entry.record) },
      );
    }

    if (held.length > 0) {
      this.logger.warn(
        `MarginFront rejected this API key (HTTP ${status}) while retrying ${held.length} held event(s). They're still queued: one more rejection like this drops them, so check the key if this warning repeats.`,
      );
      this.requeueDuringAuthHold(held);
    }
  }

  // Same front-insert as requeueAfterFailure but with NO backoff escalation:
  // the confirming retry must land one base interval (~10s) later, not after
  // a doubled backoff.
  private requeueDuringAuthHold(entries: BufferedRecord[]): void {
    this.buffer = [...entries, ...this.buffer];
    this.trimToCap();
  }

  // Survivors go back at the FRONT of the buffer — ahead of anything pushed
  // while the flush was in flight — so under cap pressure they are the first
  // evicted, consistent with the oldest-drop policy.
  private requeueAfterFailure(entries: BufferedRecord[]): void {
    const survivors = entries.filter((entry) => {
      if (entry.attempts >= MAX_ATTEMPTS) {
        this.logger.warn(
          `Event dropped after ${MAX_ATTEMPTS} retries. MarginFront never accepted it and the failure wasn't an auth problem, so check that this machine can reach the MarginFront server you configured (baseUrl or MARGINFRONT_API_URL) and that the server is running.`,
          { record: entry.record },
        );
        return false;
      }
      return true;
    });

    const droppedCount = entries.length - survivors.length;
    if (droppedCount > 0) {
      this.logger.warn(
        `RetryBuffer dropped ${droppedCount} event(s) after max retries`,
      );
    }

    this.buffer = [...survivors, ...this.buffer];
    this.trimToCap();
    this.currentIntervalMs = Math.min(
      this.currentIntervalMs * 2,
      MAX_FLUSH_INTERVAL_MS,
    );
  }

  private trimToCap(): void {
    while (this.buffer.length > MAX_BUFFER_SIZE) {
      const dropped = this.buffer.shift();
      this.logger.warn(
        `RetryBuffer full (${MAX_BUFFER_SIZE} events), dropping oldest event`,
        { droppedRecord: dropped?.record },
      );
    }
  }

  private reportRecovery(): void {
    if (this.authDroppedSinceRecovery === 0) return;
    const count = this.authDroppedSinceRecovery;
    this.authDroppedSinceRecovery = 0;
    this.logger.warn(
      `MarginFront is accepting events again. ${count} event(s) were dropped while the key was rejected and can't be recovered.`,
    );
  }

  private settleTimer(): void {
    if (this.buffer.length === 0) {
      this.stopTimer();
    }
  }

  private ensureTimer(): void {
    if (this.flushTimer !== null) return;

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      await this.flush();
      // If there are still events after flush, schedule the next one
      if (this.buffer.length > 0) {
        this.ensureTimer();
      }
    }, this.currentIntervalMs);

    // Don't hold the Node process open just because the buffer has a timer
    if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
      this.flushTimer.unref();
    }
  }

  private stopTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
