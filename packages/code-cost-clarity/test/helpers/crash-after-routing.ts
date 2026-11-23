// crash-after-routing.ts
// ---------------------------------------------------------------------------
// NOT a test (vitest only collects *.test.ts): the child process that
// connector.test.ts's crash test drives. It installs the file routing the Windows
// task uses and then dies the way the meter would - asynchronously, past any
// try/catch a caller could wrap around it.
//
// Run as:  node --import test/helpers/ts-import-hook.mjs \
//            test/helpers/crash-after-routing.ts <outPath> <errPath> <exception|rejection>
// ---------------------------------------------------------------------------

import { routeConsoleOutputToFiles } from "../../src/connector";

const [outPath, errPath, kind] = process.argv.slice(2);
if (!outPath || !errPath) throw new Error("need an out path and an err path");

routeConsoleOutputToFiles(outPath, errPath);
console.log("routing installed");

if (kind === "rejection") {
  void Promise.reject(new Error("CRASH-CANARY from a rejected promise"));
} else {
  setTimeout(() => {
    throw new Error("CRASH-CANARY from a timer");
  }, 0);
}
