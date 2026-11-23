// fixture-http-server.mjs - a throwaway loopback server for the curl tests.
// (Not a test file; vitest only collects *.test.ts.)
//
// WHY IT IS A SEPARATE PROCESS AND NOT AN IN-TEST SERVER: production downloads with
// execFileSync, which blocks the whole event loop until curl exits. A server living in
// the test's own process could never answer the request curl is waiting on, and the
// two would deadlock until the suite timed out. So the server gets its own process.
//
// Usage: node fixture-http-server.mjs <fileToServe>
// Prints "port=<n>" on stdout once it is listening, then serves:
//   /collector.tar.gz  - the file, 200
//   /redirected.tar.gz - a 302 to the above, so curl's -L is really exercised
//   anything else      - an HTML 404, so curl's -f has something real to refuse

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const bytes = readFileSync(process.argv[2]);

const server = createServer((req, res) => {
  if (req.url === "/collector.tar.gz") {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(bytes);
    return;
  }
  if (req.url === "/redirected.tar.gz") {
    res.writeHead(302, { location: "/collector.tar.gz" });
    res.end();
    return;
  }
  // An HTML body on purpose: without curl's -f this is what would land on disk and
  // get checksummed as if it were a collector.
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<html><body>not found</body></html>");
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`port=${server.address().port}\n`);
});
