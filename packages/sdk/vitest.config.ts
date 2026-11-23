import { defineConfig } from "vitest/config";

// The SDK has no built-in server, so the suite names a local one. Tests that
// pin the "nothing is set" behaviour delete this variable themselves.
export default defineConfig({
  test: {
    env: {
      MARGINFRONT_API_URL: "http://localhost:4000/v1",
    },
  },
});
