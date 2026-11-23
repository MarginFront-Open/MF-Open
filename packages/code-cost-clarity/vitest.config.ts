import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The safety belt. It runs before every test file and stops the suite dead if
    // HOME is a real user home holding a live ~/.marginfront-ccc install, because
    // parts of this suite reach paths that homedir() fixed at module load and would
    // delete that install. See test/helpers/no-real-home.ts for the full story and
    // the CCC_TEST_ALLOW_REAL_HOME=1 override.
    setupFiles: ["./test/helpers/no-real-home.ts"],
    // There is no built-in server, so the suite names a local one. Tests that pin
    // the "nothing is set" behaviour delete this variable themselves.
    env: {
      MARGINFRONT_API_URL: "http://localhost:4000/v1",
    },
  },
});
