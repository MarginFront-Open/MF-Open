# The SDK, the MCP server and the meter

Three packages in this repository talk to your MarginFront API from somewhere
else: your app, an AI assistant, or a developer's machine. You build them from
this repository and point them at your own server.

| Package                 | Folder                       | What it's for                                                                                   | Full guide                                                                      |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| SDK                     | `packages/sdk`               | Send usage events and read billing data from a Node.js app. Also has a small command-line tool. | [packages/sdk/README.md](../packages/sdk/README.md)                             |
| MCP server              | `packages/mcp`               | Give an AI assistant tools to read and record billing data.                                     | [packages/mcp/README.md](../packages/mcp/README.md)                             |
| Code Cost Clarity meter | `packages/code-cost-clarity` | Record what each developer spends in Claude Code and Codex.                                     | [packages/code-cost-clarity/README.md](../packages/code-cost-clarity/README.md) |
| React components        | `packages/react`             | A pricing table, invoice views and a usage chart for your own pages.                            | [packages/react/README.md](../packages/react/README.md)                         |

## Don't install them from npm

Packages named `@marginfront/sdk`, `@marginfront/mcp` and
`@marginfront/code-cost-clarity` exist on npm. They're deprecated, and they send your API key and usage data to
a fixed address that this project doesn't control. Don't install them. Build
from this repository instead.

If you already have one installed, remove it. For the meter, run its
`uninstall` command first, because it runs in the background after you sign
in.

## Before you build

1. A running MarginFront API, and its address including `/v1`, for example
   `https://api.example.com/v1`, or `http://localhost:4000/v1` on your own
   machine.
2. An API key from the dashboard: **Build**, then **API keys**, then
   **Create key pair**. That gives you a secret key (`mf_sk_...`) and a
   publishable key (`mf_pk_...`). Use the secret key on servers and the
   publishable key in browsers.
3. A checkout of this repository with `npm ci` run at the root.

## Build

From the repository root, build the one you need:

```bash
npx turbo run build --filter=@marginfront/sdk
npx turbo run build --filter=@marginfront/mcp
npx turbo run build --filter=@marginfront/code-cost-clarity
npx turbo run build --filter=@marginfront/react
```

`npx turbo` runs the build tool already installed in the checkout. It downloads
nothing. Each command ends with `Tasks: ... successful`. The output lands in
that package's `dist` folder.

## The one server setting

All three of the SDK, the MCP server and the meter send to one address:
`MARGINFRONT_API_URL`. There's no built-in default. Without it, each one stops
and says what to set.

- Include `/v1`: `https://api.example.com/v1`. A path in front of `/v1` is kept,
  so `https://example.com/billing/v1` works.
- It must be `https://`, or `http://` to this machine only (`localhost`,
  `127.0.0.1` or `[::1]`).
- Plain `http://` to another machine is refused, because the key would travel
  unencrypted. If your server is on a private network you trust, set
  `MARGINFRONT_ALLOW_INSECURE_HTTP=1`.
- An address with a username, password, `?query` or `#fragment` is refused.
- Every request is checked against that address before it's sent, and a
  redirect from the server is refused, so the key can't follow one elsewhere.

Where each package reads it:

| Package          | Where the setting goes                                                                             | The key goes in                                           |
| ---------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| SDK              | The `baseUrl` option in code, or `MARGINFRONT_API_URL` in your app's environment. `baseUrl` wins.  | The `apiKey` option                                       |
| SDK command line | `--base-url`, `MARGINFRONT_API_URL` in your shell, or a `.env.marginfront.cli` file                | `--api-key` or `MF_API_SECRET_KEY`                        |
| MCP server       | The `env` block of your MCP client's config                                                        | `MF_API_SECRET_KEY` in the same block                     |
| Meter            | `~/.marginfront-ccc/.env`, written by `init` (`init --api-url <address>` sets it without a prompt) | `MARGINFRONT_API_KEY` in the same file, written by `init` |
| React            | The `apiBaseUrl` prop on `MarginFrontProvider`. It doesn't read `MARGINFRONT_API_URL`.             | The `apiKey` prop. Use a publishable key.                 |

## Using them

**SDK.** Install the built folder into your app and pass the address:

```bash
npm install /path/to/marginfront/packages/sdk
```

```typescript
import { MarginFrontClient } from "@marginfront/sdk";

const client = new MarginFrontClient({
  apiKey: "mf_sk_your_secret_key",
  baseUrl: "https://api.example.com/v1",
});
```

**MCP server.** Point your client at the built file with `node`:

```json
{
  "mcpServers": {
    "marginfront": {
      "command": "node",
      "args": ["/absolute/path/to/marginfront/packages/mcp/dist/index.js"],
      "env": {
        "MF_API_SECRET_KEY": "mf_sk_your_secret_key",
        "MARGINFRONT_API_URL": "https://api.example.com/v1"
      }
    }
  }
}
```

**Meter.** Run its setup, which asks for the address and the key:

```bash
node packages/code-cost-clarity/dist/cli.js init
```

`init` downloads an OpenTelemetry collector (about 360 MB, once), shows every
change it wants to make and asks before making any. It copies itself to
`~/.marginfront-ccc/cli.js`, and later commands run from there, for example
`node ~/.marginfront-ccc/cli.js status`.

## Updating

Nothing checks for updates and nothing downloads a newer build. When you update
your server, pull this repository, run the build command again, and restart
whatever uses the package. For the meter, run `init` again: it replaces the
installed copy.

## Proxies, browsers and Windows

- The SDK ignores `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` on purpose:
  axios would send the request, key included, to the proxy as plain HTTP. If
  your machines reach the internet only through a proxy, give the axios client
  in `packages/sdk/src/utils/http.ts` an `httpsAgent` that tunnels TLS through
  your proxy.
- In a browser, redirects are followed by the browser itself, so the SDK
  can't refuse them there. Use a publishable key in browser code.
- On Windows, `~` in `node ~/.marginfront-ccc/cli.js` works in Git Bash and
  PowerShell 7.5 or newer. In `cmd.exe` and older PowerShell, spell the path
  out: `node "%USERPROFILE%\.marginfront-ccc\cli.js"`.
