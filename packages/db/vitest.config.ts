import { defineConfig } from "vitest/config";

// Scoped to scripts/__tests__ only: src/**/*.test.ts files here are standalone
// tsx assert scripts (run via `npx tsx <file>`), not vitest suites — collecting
// them fails with "No test suite found".
//
// *.integration.test.ts is excluded and runs via `npm run test:integration`,
// mirroring apps/dashboard. These files import @prisma/client at module scope to
// talk to a real database, and CI runs this package's test task BEFORE
// `prisma generate` — so collecting them here dies with "@prisma/client did not
// initialize yet" before their own TEST_DB_URL skip-gate can skip anything.
export default defineConfig({
  test: {
    include: ["scripts/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
