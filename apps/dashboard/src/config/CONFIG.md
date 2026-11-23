# Dashboard configuration code

This folder holds the dashboard's configuration system: typed settings built
from JSON files and environment variables. For the list of environment
variables an operator sets, see
[docs/configuration.md](../../../../docs/configuration.md).

## Files

```
src/config/
├── environments/
│   ├── base.json          # Shared defaults
│   ├── development.json   # Local development overrides
│   ├── preview.json       # Preview deployment overrides
│   └── production.json    # Production overrides
├── schema.ts              # TypeScript types for the config
├── schema.json            # JSON Schema for the same shape
├── loader.ts              # Builds the config and reads secrets
├── operator.ts            # The operator's branding and links (company name, support email, docs URL)
├── source-install.ts      # Install commands shown for the SDK, MCP server and meter
├── sentry.ts              # Sentry setup and replay privacy options
├── logger.ts              # Console or Better Stack logging
└── index.ts               # Public exports
```

## How the config is built

Later sources override earlier ones:

1. `environments/base.json`
2. `environments/<environment>.json`
3. Environment variables read in `loader.ts`

The environment comes from `NEXT_PUBLIC_APP_ENV`, then `VERCEL_ENV`, then
`NODE_ENV`.

## Using it

```typescript
import { config, environment, resolveEndpoint, buildApiUrl } from '@/config'

const apiUrl = config.api.baseUrl

const endpoint = resolveEndpoint(config.api.endpoints.agents.detail, {
  orgId: '123',
  agentId: '456',
})
const fullUrl = buildApiUrl(endpoint)
```

Secrets are only for server code (server components, server actions, route
handlers):

```typescript
import { loadSecrets } from '@/config'

const secrets = loadSecrets()
```

`getClientConfig()` returns only the values that are safe to send to the
browser. `validateConfig(config)` and `validateSecrets()` report problems
without throwing.

## Adding a setting

1. Add the default to `environments/base.json`.
2. Add its type in `schema.ts`, and to `schema.json`.
3. If an environment variable should override it, read it in `loader.ts`.
4. Add the variable to `apps/dashboard/.env.example` and to
   `docs/configuration.md`.

Never put a secret in a JSON file or in a `NEXT_PUBLIC_` variable.
