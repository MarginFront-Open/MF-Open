// collector-selfheal.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: the collector self-heal decision logic does the
// right thing on every tick - and, crucially, that it does NOT spin into a tight
// crash-loop when the collector refuses to stay up.
//
// WHY IT EXISTS: the collector is the process that actually
// writes down every dollar of model usage. It runs detached, invisible to the launchd
// daemon that babysits the forwarder. So if the collector dies but the forwarder lives,
// the forwarder would poll a file that never grows again - no error, no crash, spend
// silently going uncounted. For a meter whose one rule is "never under-count," that is
// the worst failure. maybeReviveCollector, called once per poll tick, is the safety net.
//
// HOW WE TEST IT: maybeReviveCollector takes its dependencies (is-the-collector-alive,
// how-to-revive-it, the clock) as injected functions. That lets us drive every branch
// deterministically with spies and a fake clock - no real collector process, no real
// pidfile, no sleeping. The assertions check the ACTUAL function output and the ACTUAL
// number of revive calls, so they fail if the logic is wrong; they are not trivially
// green. (Killing the collector while the forwarder is live is checked by hand,
// not here.)
// ---------------------------------------------------------------------------

import { test, expect, vi } from "vitest";
import { maybeReviveCollector, type CollectorHealDeps } from "../src/forwarder";

// A generous backoff window for the tests, in the same ballpark as production's 30s.
const BACKOFF_MS = 30_000;

// Build a deps bundle wired to spies + a fake clock the test fully controls. `alive`
// is the collector's reported liveness; `nowRef.value` is the wall clock in ms.
function makeDeps(alive: boolean, nowRef: { value: number }) {
  const reviveCollector = vi.fn();
  const log = vi.fn();
  const deps: CollectorHealDeps = {
    isCollectorAlive: () => alive,
    reviveCollector,
    now: () => nowRef.value,
    log,
  };
  return { deps, reviveCollector, log };
}

// ---------------------------------------------------------------------------
// 1. Collector ALIVE → never revive, never change the backoff state.
//
// This is the overwhelmingly common case (the collector is fine). If self-heal fired
// here it would needlessly spawn a second collector. The function must be a pure no-op.
// ---------------------------------------------------------------------------
test("collector alive: does NOT revive and leaves the backoff state untouched", () => {
  const nowRef = { value: 1_000_000 };
  const { deps, reviveCollector, log } = makeDeps(true, nowRef);

  // nextReviveAllowedAt = 0 means "eligible to revive immediately" - yet because the
  // collector is alive, we must still do nothing.
  const next = maybeReviveCollector(deps, 0, BACKOFF_MS);

  expect(reviveCollector).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(next).toBe(0); // state returned unchanged
});

// ---------------------------------------------------------------------------
// 2. Collector DEAD and past the window → revive exactly once, arm the next window.
//
// A dead collector gets brought back.
// ---------------------------------------------------------------------------
test("collector dead, past backoff window: revives once and returns now + backoff", () => {
  const nowRef = { value: 1_000_000 };
  const { deps, reviveCollector, log } = makeDeps(false, nowRef);

  // nextReviveAllowedAt = 0 < now, so we're past any window - revive is allowed.
  const next = maybeReviveCollector(deps, 0, BACKOFF_MS);

  expect(reviveCollector).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith("collector was down, restarted it");
  // The returned state is the next time a revive is allowed.
  expect(next).toBe(nowRef.value + BACKOFF_MS);
});

// ---------------------------------------------------------------------------
// 3. Collector DEAD but still inside the window → do NOT revive (the backoff holds).
//
// Without this guard, a collector that's down would be respawned every single tick.
// ---------------------------------------------------------------------------
test("collector dead, inside backoff window: does NOT revive and holds the state", () => {
  const nowRef = { value: 1_000_000 };
  const { deps, reviveCollector, log } = makeDeps(false, nowRef);

  // We revived 5s ago and the window is 30s, so the next allowed time is 25s ahead of
  // "now". The function must refuse to revive again until the clock passes that mark.
  const nextAllowedAt = nowRef.value + 25_000;
  const next = maybeReviveCollector(deps, nextAllowedAt, BACKOFF_MS);

  expect(reviveCollector).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(next).toBe(nextAllowedAt); // unchanged - still backing off
});

// ---------------------------------------------------------------------------
// 4. The crash-loop guard, end to end: a collector that is ALWAYS dead, polled every
//    second for two full backoff windows, must be revived at most once per window.
//
// This is the key assertion. We thread the returned state
// back in on each tick exactly as watchAndForward's setInterval does, advancing a fake
// clock by 1s per tick (matching WATCH_POLL_MS). Over 65 one-second ticks with a 30s
// window we expect 3 revives (at t=0, t≈30s, t≈60s), NOT 65.
// ---------------------------------------------------------------------------
test("persistently dead collector: revives at most once per backoff window (no tight loop)", () => {
  const nowRef = { value: 0 };
  const { deps, reviveCollector } = makeDeps(false, nowRef);

  let nextReviveAllowedAt = 0;
  const TICK_MS = 1_000; // WATCH_POLL_MS
  const TICKS = 65; // 65 seconds of polling

  for (let i = 0; i < TICKS; i++) {
    nextReviveAllowedAt = maybeReviveCollector(
      deps,
      nextReviveAllowedAt,
      BACKOFF_MS,
    );
    nowRef.value += TICK_MS;
  }

  // 65s / 30s window = revives at t=0, t=30s, t=60s → exactly 3. A broken guard that
  // revived every tick would show 65; one that never re-armed would show 1.
  expect(reviveCollector).toHaveBeenCalledTimes(3);
});

// ---------------------------------------------------------------------------
// 5. Revive that THROWS still arms the backoff (so a sick collector can't spin us).
//
// startCollector can throw (missing binary, spawn refused). If a throw skipped the
// backoff bump, the next tick would immediately try again - the exact tight loop we're
// guarding against. The window must be armed BEFORE the revive call, win or lose.
// ---------------------------------------------------------------------------
test("revive throws: still returns now + backoff so the next tick backs off", () => {
  const nowRef = { value: 500_000 };
  const log = vi.fn();
  const reviveCollector = vi.fn(() => {
    throw new Error("collector binary is missing");
  });
  const deps: CollectorHealDeps = {
    isCollectorAlive: () => false,
    reviveCollector,
    now: () => nowRef.value,
    log,
  };

  const next = maybeReviveCollector(deps, 0, BACKOFF_MS);

  // It attempted the revive (once)...
  expect(reviveCollector).toHaveBeenCalledTimes(1);
  // ...the failure was logged in plain English (not swallowed)...
  expect(log).toHaveBeenCalledWith(
    "collector revive attempt failed: collector binary is missing",
  );
  // ...and CRUCIALLY the window is still armed, so the next tick won't retry instantly.
  expect(next).toBe(nowRef.value + BACKOFF_MS);
});

// ---------------------------------------------------------------------------
// 6. Right after a revive, the very next tick is a no-op (immediate re-entry guard).
//
// Belt-and-suspenders for scenario 4: prove that feeding the returned state straight
// back in on the same clock yields zero additional revives.
// ---------------------------------------------------------------------------
test("immediately after a revive: the next tick at the same instant does not revive again", () => {
  const nowRef = { value: 2_000_000 };
  const { deps, reviveCollector } = makeDeps(false, nowRef);

  const afterFirst = maybeReviveCollector(deps, 0, BACKOFF_MS);
  expect(reviveCollector).toHaveBeenCalledTimes(1);

  // Same instant, state threaded back in: must NOT revive again.
  const afterSecond = maybeReviveCollector(deps, afterFirst, BACKOFF_MS);
  expect(reviveCollector).toHaveBeenCalledTimes(1);
  expect(afterSecond).toBe(afterFirst); // window unchanged
});
