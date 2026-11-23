// stand-in-forwarder.ts - a fake forwarder for the `stop` tests to really kill.
// (Not a test file; vitest only collects *.test.ts.)
//
// WHY IT IS A SEPARATE PROGRAM: the thing under test is whether `stop` can bring a
// LIVE process down cleanly, and no in-process spy can prove that. So the stop tests
// spawn this, then run the real stop ladder against its real pid.
//
// WHY IT IMPORTS FROM src/: the polite rung of that ladder is a pair - `stop` writes
// a request, the forwarder reads it. If this file re-implemented the reader, the test
// would keep passing after the real reader broke. It calls the SAME
// readShutdownRequest the real `run` loop calls, so the two halves are proved to
// agree. Run with `node --import test/helpers/ts-import-hook.mjs`.
//
// Usage: <teardownMarkerPath> <shutdownRequestPath> <"obey" | "wedged">
//
//   obey   - shuts down the way a healthy forwarder does, through whichever rung this
//            platform actually uses, and leaves the marker file behind as proof it ran
//            its own shutdown path instead of being shot.
//   wedged - traps SIGTERM and does nothing, and never reads the mailbox. Nothing but
//            a hard kill stops it, and it can never write the marker.

import { writeFileSync } from "node:fs";
import process from "node:process";
import {
  readShutdownRequest,
  SHUTDOWN_REQUEST_POLL_MS,
} from "../../src/connector";

const [teardownMarkerPath, shutdownRequestPath, mode] = process.argv.slice(2);

// Stands in for the real teardown: clearing the watch timer, releasing the pidfile,
// and stopping the collector this process started. The marker is the visible evidence
// that the process reached its own shutdown code rather than being terminated. It is
// NOT a flush - the real forwarder has no flush entry point, and does not need one:
// its cursor advances only after a batch lands, so a batch caught mid-send is re-read
// on the next run and deduped server-side.
function orderlyShutdown(): void {
  writeFileSync(teardownMarkerPath, "torn-down");
  process.exit(0);
}

if (mode === "obey") {
  process.on("SIGTERM", orderlyShutdown);
  setInterval(() => {
    if (readShutdownRequest(process.pid, shutdownRequestPath)) {
      orderlyShutdown();
    }
  }, SHUTDOWN_REQUEST_POLL_MS);
} else {
  // Listening for SIGTERM is allowed on Windows even though nothing raises it there;
  // this branch's whole job is to survive the polite rung on every platform.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

// Last, so a reader of "ready" knows the shutdown path above is fully wired. Sending
// the polite stop before this point would race the default terminate-on-SIGTERM
// behaviour on POSIX and the test would prove nothing.
process.stdout.write("ready\n");
