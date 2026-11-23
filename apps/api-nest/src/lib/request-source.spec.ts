import { readFileSync } from 'fs';
import { join } from 'path';
import { detectSource } from './request-source';

/**
 * Tests for detectSource().
 *
 * The function maps an incoming User-Agent (and optional URL path) to one of
 * the Source values used to label callers in alerts and Sentry.  Every row below is a real-world
 * scenario - if any branch changes accidentally these tests will catch it.
 */
describe('detectSource', () => {
  // ── code-cost-clarity forwarder ───────────────────────────────────────────
  // The @marginfront/code-cost-clarity package sends:
  //   User-Agent: @marginfront/code-cost-clarity/0.5.0
  // We want these tagged as 'ccc' so they read as developer token spend.

  it("returns 'ccc' for the code-cost-clarity package user-agent", () => {
    expect(detectSource('@marginfront/code-cost-clarity/0.5.0')).toBe('ccc');
  });

  it("returns 'ccc' for a code-cost-clarity user-agent with a future version number", () => {
    expect(detectSource('@marginfront/code-cost-clarity/1.2.3')).toBe('ccc');
  });

  it("returns 'ccc' for a mixed-case code-cost-clarity user-agent (case-insensitive check)", () => {
    // detectSource matches the user-agent case-insensitively.
    expect(detectSource('@Marginfront/Code-Cost-Clarity/0.5.0')).toBe('ccc');
  });

  // ── SDK ───────────────────────────────────────────────────────────────────

  it("returns 'sdk' for the @marginfront/sdk user-agent", () => {
    expect(detectSource('@marginfront/sdk/2.1.0')).toBe('sdk');
  });

  it("returns 'sdk' for the legacy marginfront-sdk user-agent", () => {
    expect(detectSource('marginfront-sdk/1.0.0')).toBe('sdk');
  });

  it("returns 'sdk' for the exact UA the SDK builds from its package.json", () => {
    // Read the version at test time so this test can never pin a stale literal.
    const { version } = JSON.parse(
      readFileSync(join(__dirname, '../../../../packages/sdk/package.json'), 'utf8'),
    ) as { version: string };
    expect(detectSource(`marginfront-sdk/${version}`)).toBe('sdk');
  });

  // ── MCP ───────────────────────────────────────────────────────────────────

  it("returns 'mcp' for the @marginfront/mcp user-agent", () => {
    expect(detectSource('@marginfront/mcp/3.0.0')).toBe('mcp');
  });

  it("returns 'mcp' for the legacy marginfront-mcp user-agent", () => {
    expect(detectSource('marginfront-mcp/1.0.0')).toBe('mcp');
  });

  // ── Portal URL override ───────────────────────────────────────────────────
  // Portal routes override the UA check because portal browsers look like
  // dashboard browsers.

  it("returns 'portal' when the URL path starts with /portal/", () => {
    expect(detectSource('Mozilla/5.0', '/portal/some-path')).toBe('portal');
  });

  it("returns 'portal' when the URL path starts with /v1/portal/", () => {
    expect(detectSource('Mozilla/5.0', '/v1/portal/invoices')).toBe('portal');
  });

  // ── Dashboard (browser) ───────────────────────────────────────────────────

  it("returns 'dashboard' for a standard browser user-agent", () => {
    expect(
      detectSource(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      ),
    ).toBe('dashboard');
  });

  // ── API fallback ──────────────────────────────────────────────────────────
  // Anything unrecognised (raw curl, custom HTTP clients, etc.) falls back to
  // 'api' so we still track the event, we just can't attribute the surface.

  it("returns 'api' when no user-agent is provided", () => {
    expect(detectSource(undefined)).toBe('api');
  });

  it("returns 'api' when the user-agent is an empty string", () => {
    expect(detectSource('')).toBe('api');
  });

  it("returns 'api' for an unknown / unrecognised user-agent string", () => {
    expect(detectSource('python-requests/2.31.0')).toBe('api');
  });

  it("returns 'api' for a plain curl user-agent", () => {
    expect(detectSource('curl/8.4.0')).toBe('api');
  });
});
