# Changelog

## 2.0.0 (2026-11-17): built from source, and you name the server (breaking)

You build this package from this repository, and it isn't published to npm. It
sends to the MarginFront server you name.

**What breaks, and what to do:**

- **`apiBaseUrl` is required.** `<MarginFrontProvider>` has no default server: pass
  your server's API address, including `/v1` (for example
  `apiBaseUrl="https://billing.example.com/v1"`). Without it the provider throws an
  error that says what to set.
- **Build it from source.** Run `npx turbo run build --filter=@marginfront/react` from
  the repository root. The package is marked `private` so it cannot be published by
  accident.
- **`PlanQuiz` says "Choose this plan"** instead of "Start free trial", because your
  plans may not have a trial. The button still calls your `onSelectPlan`.
