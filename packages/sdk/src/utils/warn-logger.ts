/**
 * Warn Logger
 *
 * The sink for data-loss warnings (retry buffer drops, auth drops). Routable
 * through the same `logging` config as the HTTP logger, with one deliberate
 * difference: it defaults ON. A zero-config customer must still hear about
 * lost events, so only an explicit `logging: { enabled: false }` silences it.
 * `logging.level` and `debug` are ignored here on purpose: a data-loss
 * warning is not routine log noise, so quieting routine logs must not hide it.
 */

import type { LogHandler, MarginFrontConfig } from "../types";

const THROTTLE_WINDOW_MS = 60_000;

export interface WarnSink {
  warn(msg: string, data?: unknown): void;
  warnThrottled?(key: string, msg: string, data?: unknown): boolean;
}

export class WarnLogger implements WarnSink {
  private readonly enabled: boolean;
  private readonly handler?: LogHandler;
  private readonly lastEmitMsByKey = new Map<string, number>();

  constructor(config: MarginFrontConfig) {
    this.enabled = config.logging?.enabled ?? true;
    this.handler = config.logging?.handler;
  }

  warn(msg: string, data?: unknown): void {
    if (!this.enabled) return;
    if (this.handler) {
      this.handler("warn", msg, data);
      return;
    }
    console.warn(`[MarginFront] ${msg}`, data ?? "");
  }

  // Emits at most once per 60s per key. Returns whether it emitted so the
  // caller can carry suppressed counts into the next emitted message. Uses
  // Date.now(); a backward wall-clock jump costs at most one extra warning.
  warnThrottled(key: string, msg: string, data?: unknown): boolean {
    if (!this.enabled) return false;
    const now = Date.now();
    const lastEmit = this.lastEmitMsByKey.get(key);
    if (lastEmit !== undefined && now - lastEmit < THROTTLE_WINDOW_MS) {
      return false;
    }
    this.lastEmitMsByKey.set(key, now);
    this.warn(msg, data);
    return true;
  }
}
