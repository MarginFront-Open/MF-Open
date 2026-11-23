import { defineConfig } from "vitest/config";

// The database-backed suites. They self-skip without their DB URL, but must be
// run deliberately because collecting them requires a generated Prisma client.
export default defineConfig({
  test: {
    include: ["scripts/__tests__/**/*.integration.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
