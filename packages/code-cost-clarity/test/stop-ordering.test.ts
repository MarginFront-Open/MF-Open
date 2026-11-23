// stop-ordering.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: `code-cost-clarity stop` stops the forwarder FIRST and only stops the
// collector once the forwarder is confirmed gone.
//
// WHY IT EXISTS: the forwarder runs a once-a-second
// self-heal loop that revives a dead collector. If `stop` killed the collector while
// that loop was still ticking, the very next tick would resurrect the collector - and
// if the forwarder had attached to a collector it did not start itself, the forwarder's
// own shutdown won't stop it, so the revived collector would be left running with
// nobody watching it. That breaks the promise that `stop` leaves nothing running.
//
// These tests drive the REAL ordering function (stopForwarderThenStopCollector) with
// injected fakes that record the order of actions and, crucially, whether the forwarder
// was still alive at the instant the collector was stopped. The headline assertion -
// "forwarder NOT alive when stopCollector ran" - is exactly the invariant a
// collector-first ordering violates, so that order fails here.
// ---------------------------------------------------------------------------

import { test, expect } from "vitest";
import { stopForwarderThenStopCollector, type StopDeps } from "../src/cli";

// Tiny fake of the world `stop` operates in. We model a forwarder process whose
// liveness we control, a collector we can "stop", and a clock the sleep advances -
// no real processes, no real waiting.
function makeWorld(opts: {
  // true  -> forwarder is running when stop begins
  // false -> nothing is running (e.g. a stale/leftover pidfile)
  aliveAtStart: boolean;
  // After this many sleep()s, the forwarder dies on its own (models a clean SIGTERM
  // shutdown landing). Use Infinity to model a wedged forwarder that ignores SIGTERM.
  diesAfterPolls: number;
}) {
  const order: string[] = [];
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  let forwarderAlive = opts.aliveAtStart;
  let pollsUntilDeath = opts.diesAfterPolls;
  let clock = 0;
  // The single most important recorded fact: was the forwarder still alive at the
  // moment we stopped the collector? It MUST be false - that is what makes the revive
  // race impossible.
  let forwarderAliveWhenCollectorStopped: boolean | null = null;

  const deps: StopDeps = {
    isForwarderAlive: () => forwarderAlive,
    signalForwarder: (signal) => {
      signals.push(signal);
      order.push(signal);
      // SIGKILL models a forced, immediate kill that always succeeds.
      if (signal === "SIGKILL") forwarderAlive = false;
    },
    stopCollector: () => {
      order.push("stopCollector");
      forwarderAliveWhenCollectorStopped = forwarderAlive;
    },
    sleep: async (ms) => {
      order.push("sleep");
      clock += ms;
      if (pollsUntilDeath !== Infinity) {
        pollsUntilDeath -= 1;
        if (pollsUntilDeath <= 0) forwarderAlive = false;
      }
    },
    now: () => clock,
    log: (message) => order.push(`log:${message}`),
  };

  return {
    deps,
    order,
    signals,
    getForwarderAliveWhenCollectorStopped: () =>
      forwarderAliveWhenCollectorStopped,
  };
}

test("running forwarder: SIGTERM first, and the collector is stopped only AFTER the forwarder is gone", async () => {
  const world = makeWorld({ aliveAtStart: true, diesAfterPolls: 2 });

  await stopForwarderThenStopCollector(world.deps, 50, 1000);

  // The race-closing invariant: by the time we stop the collector, the forwarder's
  // poll loop is already gone, so it cannot revive the collector. If the collector
  // is stopped first, this flips to true and the test fails.
  expect(world.getForwarderAliveWhenCollectorStopped()).toBe(false);

  // Ordering: we asked the forwarder to stop before we touched the collector.
  const sigtermAt = world.order.indexOf("SIGTERM");
  const stopCollectorAt = world.order.indexOf("stopCollector");
  expect(sigtermAt).toBeGreaterThanOrEqual(0);
  expect(stopCollectorAt).toBeGreaterThan(sigtermAt);

  // We waited (polled) at least once before declaring the forwarder gone.
  expect(world.order.filter((s) => s === "sleep").length).toBeGreaterThan(0);

  // We did NOT need to escalate to SIGKILL on a forwarder that stopped politely.
  expect(world.signals).toEqual(["SIGTERM"]);
  // The collector is stopped exactly once.
  expect(world.order.filter((s) => s === "stopCollector").length).toBe(1);
});

test("no forwarder running: skips the signal but still stops the collector", async () => {
  const world = makeWorld({ aliveAtStart: false, diesAfterPolls: Infinity });

  await stopForwarderThenStopCollector(world.deps, 50, 1000);

  // Nothing to signal, no waiting needed.
  expect(world.signals).toEqual([]);
  expect(world.order.filter((s) => s === "sleep").length).toBe(0);
  // But `stop` must STILL stop the collector - that is the whole job of the command.
  expect(world.order.filter((s) => s === "stopCollector").length).toBe(1);
  // Trivially true here (forwarder was never alive), but asserted to keep the
  // invariant identical across every path.
  expect(world.getForwarderAliveWhenCollectorStopped()).toBe(false);
});

test("wedged forwarder: escalates to SIGKILL after the timeout, then stops the collector once it's down", async () => {
  // Forwarder ignores SIGTERM forever, so the grace period expires and we force it.
  const world = makeWorld({ aliveAtStart: true, diesAfterPolls: Infinity });

  await stopForwarderThenStopCollector(world.deps, 50, 200);

  // SIGTERM came first, SIGKILL was the escalation.
  expect(world.signals).toEqual(["SIGTERM", "SIGKILL"]);
  const sigkillAt = world.order.indexOf("SIGKILL");
  const stopCollectorAt = world.order.indexOf("stopCollector");
  expect(sigkillAt).toBeGreaterThan(world.order.indexOf("SIGTERM"));
  expect(stopCollectorAt).toBeGreaterThan(sigkillAt);

  // Even for a wedged forwarder, the collector is only stopped after the forwarder is
  // truly down - "leave nothing running" holds, with no revive race.
  expect(world.getForwarderAliveWhenCollectorStopped()).toBe(false);
  expect(world.order.filter((s) => s === "stopCollector").length).toBe(1);
});
