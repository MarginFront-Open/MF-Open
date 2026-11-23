# Security

## Reporting a vulnerability

Report security problems privately through GitHub: open this repository's
**Security** tab and choose **Report a vulnerability**. Please don't open a
public issue for one.

Include what the problem is and which part it's in (dashboard, API or a
package), the steps to reproduce it on a local copy, what someone could do
with it, and the commit you tested. Don't include real customer data, real
keys or anyone's personal information.

## Running your own copy safely

- Keep `ENCRYPTION_KEY`, `AUTH_SECRET`, `CRON_SECRET` and every provider key
  out of version control and out of `NEXT_PUBLIC_` variables.
- Turn on the bot check, run Redis, and put the API behind exactly one reverse
  proxy. See [docs/self-hosting.md](docs/self-hosting.md).
- Never set `SKIP_OTP_EMAIL` or `SKIP_MAGIC_LINK_EMAIL` on a server other
  people can reach.
- Review what's public and who can see money before you go live. See
  [docs/make-it-yours.md](docs/make-it-yours.md#whats-public-and-who-sees-money).
- Build the `@marginfront/*` packages from this repository rather than
  installing them from npm. See [docs/packages.md](docs/packages.md).
