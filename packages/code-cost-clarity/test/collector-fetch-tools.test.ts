// collector-fetch-tools.test.ts
// ---------------------------------------------------------------------------
// WHAT THIS FILE PROVES: that the two external tools the collector install depends
// on - curl and tar - exist on this machine and accept the EXACT argument shapes
// production uses.
//
// WHY IT EXISTS. ensureCollectorBinary shells out to curl and then to tar, and it is
// reachable only through `init`. Without this file the first machine to run those two
// invocations on Windows would be a user's, forty seconds into a 360 MB download.
// Windows 10 1803 and later ship both (curl.exe and bsdtar as tar.exe, in System32),
// but "ships it" and "accepts our arguments" are different claims. bsdtar is not GNU
// tar; -C with a backslash path, and naming a single member to extract, are exactly
// the places two tars differ.
//
// HOW IT STAYS HONEST. It calls downloadToFile and extractTarGzMember - the SAME
// exported functions ensureCollectorBinary calls, not a copy of their arguments. A
// copy would keep passing when production moved away from it. The download is a
// few hundred bytes from a loopback server rather than the real 360 MB release, and
// nothing here calls cmdInit.
// ---------------------------------------------------------------------------

import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  collectorBinaryName,
  downloadToFile,
  extractTarGzMember,
  verifyTarballChecksum,
} from "../src/connector";

// The archive member production asks tar for on this platform - derived, not typed
// out, so the Windows .exe suffix is covered by the same test.
const MEMBER = collectorBinaryName();
const PAYLOAD = "#!/bin/sh\necho stand-in collector\n";

const FIXTURE_SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  "helpers",
  "fixture-http-server.mjs",
);

let server: ChildProcess;
let baseUrl: string;
let fixtureDir: string;
let tarballPath: string;

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "ccc-fetch-tools-"));

  // Build the archive with tar, then extract it through production's own function.
  // Creating it here rather than checking in a binary keeps the member name
  // platform-correct; the operation UNDER TEST is the extraction, and the archive it
  // reads is a real gzipped tar either way.
  const stageDir = join(fixtureDir, "stage");
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, MEMBER), PAYLOAD);
  tarballPath = join(fixtureDir, "collector-standin.tar.gz");
  execFileSync("tar", ["czf", tarballPath, "-C", stageDir, MEMBER]);

  server = spawn(process.execPath, [FIXTURE_SERVER, tarballPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    server.on("error", reject);
    server.stdout!.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/port=(\d+)/);
      if (match) resolve(match[1]);
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(() => {
  server.kill();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("curl, as production invokes it", () => {
  test("downloads a file to the exact path it was given", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-curl-"));
    const dest = join(dir, "collector.tar.gz");
    try {
      downloadToFile(`${baseUrl}/collector.tar.gz`, dest);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest)).toEqual(readFileSync(tarballPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The -f flag, load-bearing: without it curl happily writes the 404 page to disk and
  // the install proceeds to checksum an HTML file, which fails much later and much
  // more confusingly.
  test("a 404 throws instead of saving the error page", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-curl-404-"));
    const dest = join(dir, "collector.tar.gz");
    try {
      expect(() => downloadToFile(`${baseUrl}/nope.tar.gz`, dest)).toThrow();
      expect(existsSync(dest)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // -L, load-bearing: GitHub's release URL is a redirect to its CDN, so without it
  // every real download would save a redirect stub instead of a collector.
  test("follows a redirect rather than saving the redirect itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-curl-redirect-"));
    const dest = join(dir, "collector.tar.gz");
    try {
      downloadToFile(`${baseUrl}/redirected.tar.gz`, dest);
      expect(readFileSync(dest)).toEqual(readFileSync(tarballPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path with a space in it survives the invocation", () => {
    // Not hypothetical on Windows: C:\Users\First Last\... is the common case, and a
    // shell-joined command would break here.
    const dir = mkdtempSync(join(tmpdir(), "ccc-curl-space-"));
    const nested = join(dir, "a folder with spaces");
    mkdirSync(nested, { recursive: true });
    const dest = join(nested, "collector.tar.gz");
    try {
      downloadToFile(`${baseUrl}/collector.tar.gz`, dest);
      expect(existsSync(dest)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tar, as production invokes it", () => {
  test("extracts the one named member into the target directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-tar-"));
    try {
      extractTarGzMember(tarballPath, dir, MEMBER);
      const extracted = join(dir, MEMBER);
      expect(existsSync(extracted)).toBe(true);
      expect(readFileSync(extracted, "utf8")).toBe(PAYLOAD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a target directory whose path contains a space still works", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-tar-space-"));
    const nested = join(dir, "a folder with spaces");
    mkdirSync(nested, { recursive: true });
    try {
      extractTarGzMember(tarballPath, nested, MEMBER);
      expect(existsSync(join(nested, MEMBER))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a member that is not in the archive throws rather than silently doing nothing", () => {
    // This is what turns "the download was a redirect page" into a real error instead
    // of an empty config dir and a meter that never starts.
    const dir = mkdtempSync(join(tmpdir(), "ccc-tar-missing-"));
    try {
      expect(() =>
        extractTarGzMember(tarballPath, dir, "not-in-the-archive"),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file that is not an archive at all throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-tar-garbage-"));
    const garbage = join(dir, "garbage.tar.gz");
    writeFileSync(garbage, "<html>not an archive</html>");
    try {
      expect(() => extractTarGzMember(garbage, dir, MEMBER)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The download and the extraction are separated by the integrity gate, and the whole
// point of that gate is that nothing runs unless the bytes match. Proving the two
// tools work either side of it without proving the gate still holds between them
// would be proving the wrong thing.
describe("the fetch path end to end, gate included", () => {
  test("download, verify, extract - the real sequence, on real bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-fetch-e2e-"));
    const dest = join(dir, "collector.tar.gz");
    const outDir = join(dir, "out");
    mkdirSync(outDir, { recursive: true });
    try {
      downloadToFile(`${baseUrl}/collector.tar.gz`, dest);
      const expected = createHash("sha256")
        .update(readFileSync(tarballPath))
        .digest("hex");
      expect(verifyTarballChecksum(dest, expected)).toBe(true);
      extractTarGzMember(dest, outDir, MEMBER);
      expect(readFileSync(join(outDir, MEMBER), "utf8")).toBe(PAYLOAD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a tampered download fails the gate, so it never reaches tar", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccc-fetch-tamper-"));
    const dest = join(dir, "collector.tar.gz");
    try {
      downloadToFile(`${baseUrl}/collector.tar.gz`, dest);
      const wrong = createHash("sha256").update("something else").digest("hex");
      expect(verifyTarballChecksum(dest, wrong)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
