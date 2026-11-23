# Changelog

## 2.0.0 (2026-11-17): built from source, and you name the server (breaking)

You build this package from this repository, and it isn't published to npm. It
sends to the MarginFront server you name.

**What breaks, and what to do:**

- **`MARGINFRONT_API_URL` is required.** The server has no default address: set `MARGINFRONT_API_URL` in your MCP client's `env`
  block to your server's API address, including `/v1` (for example
  `https://billing.example.com/v1`). Without it the server prints what to set and
  exits. Nothing ever falls back to a built-in address.
- **`MF_API_BASE_URL` is no longer read.** Rename it to `MARGINFRONT_API_URL`. If only
  the old name is set, the server exits and says so.
- **Start it with `node`, not `npx`.** Build with
  `npx turbo run build --filter=@marginfront/mcp` from the repository root, then use
  `"command": "node"` with the full path to `packages/mcp/dist/index.js`. See the
  README.
- **Any host you choose is allowed, but it must be encrypted.** The address must be
  `https://`, or `http://` to this machine (`localhost`, `127.0.0.1`, `[::1]`). Plain
  `http://` to another machine is refused unless `MARGINFRONT_ALLOW_INSECURE_HTTP=1`
  is set. An address with a username, password, `?query` or `#fragment` is refused.
- **Redirects are refused.** A redirect from the server becomes a tool error that says
  so, and your API key is not sent to the second address.
- **Every request is checked against the configured server** before it is sent.
- **The startup update check is removed.** The server no longer contacts the npm
  registry.

**Also changed:** the links in the server's instructions now point at files in this
repository. The package is marked `private` so it
cannot be published by accident.

## Earlier versions

Versions before 2.0.0 were published to npm, and their notes aren't kept here.
Don't install those builds: they send your API key and usage to an address this
project doesn't control. See
[docs/packages.md](../../docs/packages.md#dont-install-them-from-npm).
