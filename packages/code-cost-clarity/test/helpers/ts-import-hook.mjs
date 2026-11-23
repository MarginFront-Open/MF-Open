// ts-import-hook.mjs
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS (it is NOT a test - vitest only collects *.test.ts):
//
// The CLI's user-facing commands `help`, `version`, `preview`, and `status` are
// NOT exported from src/cli.ts - they are private functions reached only through
// main()'s dispatch when the file is run as a program. The ONLY honest way to test
// them without editing src/ is to run the real CLI exactly the way a user does:
// as a child process, and assert on what it actually prints + its exit code.
//
// We run the CURRENT TypeScript source (not the published dist/, which can be a
// stale build) so the help-text assertions check the code as it stands right now.
// Node >= 22.6 can execute a .ts file directly (it strips the types), but it does
// NOT rewrite extensionless relative imports - cli.ts does `import ... from
// "./connector"`, and Node ESM wants `"./connector.ts"`. This tiny resolve hook
// fills exactly that gap: when a relative import has no file extension and a
// sibling `.ts` exists, point Node at the `.ts`. Nothing else is touched.
//
// Loaded via:  node --import <this file> src/cli.ts <command> [args]
// ---------------------------------------------------------------------------

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative =
      specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.\w+$/.test(specifier);
    if (isRelative && !hasExtension && context.parentURL) {
      const parentPath = fileURLToPath(context.parentURL);
      const candidate = resolvePath(dirname(parentPath), specifier + ".ts");
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
