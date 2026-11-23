# Changelog

## 0.23.0 (2026-11-17): built from source, and you name the server (breaking)

You build this package from this repository, and it isn't published to npm. It
sends to the MarginFront server you name.

**What breaks, and what to do:**

- **There is no default server.** `new MarginFrontClient(...)` throws an `InitializationError`
  unless you pass `baseUrl` or set the `MARGINFRONT_API_URL` environment variable to
  your server's API address, including `/v1` (for example
  `https://billing.example.com/v1`). Nothing ever falls back to a built-in address.
- **Any host you choose is allowed, but it must be encrypted.** The address must be
  `https://`, or `http://` to this machine (`localhost`, `127.0.0.1`, `[::1]`). Plain
  `http://` to another machine is refused unless you opt in with
  `allowInsecureHttp: true` or `MARGINFRONT_ALLOW_INSECURE_HTTP=1`. An address with a
  username, password, `?query` or `#fragment` is refused.
- **Redirects are refused.** If your server answers with a redirect, the request fails
  with a `NetworkError` that says so, and your API key is not sent to the second
  address. Set the final address instead.
- **Every request is checked against the configured server** before it is sent.
- **The CLI's `MF_BASE_URL` is gone.** Use `--base-url`, or `MARGINFRONT_API_URL` in
  your shell or in `.env.marginfront.cli`.
- **`checkForUpdate()` no longer contacts the npm registry.** It stays exported so
  existing code compiles, makes no network call, and always resolves to
  `{ latest: null, updateAvailable: false }`. The CLI's "update available" line is
  removed.

**Also changed:** `allowInsecureHttp` is a new client option. The package is marked
`private` so it cannot be published by accident. The README now covers building from
source.

## Earlier versions

Versions before 0.23.0 were published to npm, and their notes aren't kept here.
Don't install those builds: they send your API key and usage to an address this
project doesn't control. See
[docs/packages.md](../../docs/packages.md#dont-install-them-from-npm).
