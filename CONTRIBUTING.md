# Contributing

Fixes and improvements are welcome as pull requests. Most changes people make
are for their own deployment, and those belong in your fork: the MIT license is
there so you can make MarginFront yours.

## Set up

1. Follow the [quick start](README.md#quick-start-a-signed-in-dashboard-on-your-machine)
   to get a running copy.
2. Use Node.js 22.15 or newer for development. The apps run on 20.12, but the
   test suite needs 22.15. CI uses Node 24.
3. Use npm, not pnpm or yarn. `npm ci` installs the exact versions in
   `package-lock.json`.
4. Optional: install [gitleaks](https://github.com/gitleaks/gitleaks). The
   pre-commit hook uses it to stop you committing a secret, and skips the check
   with a message when it isn't installed.
5. Optional: turn off the build tools' own usage reporting with
   `NEXT_TELEMETRY_DISABLED=1` and `TURBO_TELEMETRY_DISABLED=1` in your shell.
   MarginFront itself sends no telemetry.

## The checks

CI runs these on every pull request. Run them from the repository root before
you push. None of them changes your files.

| Check      | Command                                                           |
| ---------- | ----------------------------------------------------------------- |
| Lint       | `npm run lint`                                                    |
| Formatting | `npm run format:check`                                            |
| Types      | `npm run typecheck`                                               |
| Unit tests | `npm test`                                                        |
| Build      | `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/v1 npm run build` |

To fix what they find, `npm run lint:fix` and `npm run format` rewrite files.

The git hooks run some of this for you: lint, formatting and types before every
push, and the secret scan before every commit.

Things that trip people up:

- **The meter's tests refuse to run against your real home folder**, because
  they install and remove files there. `npm test` handles this by giving them a
  throwaway `HOME`. To run them on their own, use
  `HOME=$(mktemp -d) npx vitest run` in `packages/code-cost-clarity`.
- **The API's type check compares against a baseline** of known errors in
  `apps/api-nest/typecheck-baseline.json`. It fails if the count goes up, and
  also if it goes down. When you fix one, run
  `npm run typecheck:baseline --workspace=@marginfront/api-nest` and commit the
  new baseline.
- **Some test suites are skipped** unless you set keys for a running API
  (`MF_TEST_BASE_URL`, `MF_TEST_SECRET_KEY`, `MF_TEST_PUBLISHABLE_KEY`) or a
  scratch database. That's expected.

## Database changes

If you change `packages/db/prisma/schema.prisma`:

1. Run `npm run db:migrate` against a local database. Prisma creates a new
   folder under `packages/db/prisma/migrations/` and applies it.
2. Restart the apps.
3. Commit the schema change and the new migration folder together.

Never edit `packages/db/prisma/migrations/0_init/migration.sql`. Databases
already built from it would no longer match.

CI applies every migration to an empty PostgreSQL 15 database and fails if the
result differs from `schema.prisma`. To run the same check yourself, point
`DATABASE_URL` and `DATABASE_URL_UNPOOLED` at one empty throwaway database and
`SHADOW_DATABASE_URL` at another, then run:

```bash
npm run db:check-migrations --workspace=@marginfront/db
```

## Code style

- TypeScript in strict mode. Avoid `any`.
- In the dashboard, style with Tailwind classes and build on the existing
  shadcn/ui components rather than editing them.
- Keep money in dollars as Prisma `Decimal` values, and follow the rules in
  [packages/db/CANON.md](packages/db/CANON.md) for anything that adds up revenue
  or cost.
- Write error messages that say what happened, why, and what to do.

## Pull requests

- Branch from `main`.
- Keep a pull request to one change, with a description of what it does and
  why.
- Write commit messages that say why, not only what: "Stop counting unsent
  emails as sent", not "fix bug".
- Add or update tests for behavior you change.

## Conduct and security

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). To
report a security problem, don't open a public issue. See
[SECURITY.md](SECURITY.md).
