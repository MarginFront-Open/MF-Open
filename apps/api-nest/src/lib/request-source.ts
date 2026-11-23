// 'ccc' = traffic from the @marginfront/code-cost-clarity package forwarding
// Claude Code / Codex token usage.
export type Source = 'sdk' | 'mcp' | 'ccc' | 'api' | 'dashboard' | 'portal';

/**
 * Infer the caller surface from the request.
 *
 * Routes under `/v1/portal/` are customer-portal traffic - those override the
 * User-Agent check because portal browsers look identical to dashboard browsers.
 * Otherwise our SDK and MCP packages set distinctive user-agent strings so we
 * can tell SDK usage apart from dashboard fetches and raw API clients.
 */
export function detectSource(userAgent?: string, urlPath?: string): Source {
  // Portal traffic is customer-facing; identified by URL prefix since portal
  // and dashboard both come from real browsers with similar user-agents.
  if (urlPath && /^\/?(?:v1\/)?portal(?:\/|$)/.test(urlPath)) return 'portal';

  if (!userAgent) return 'api';
  const ua = userAgent.toLowerCase();
  if (ua.includes('@marginfront/sdk') || ua.includes('marginfront-sdk')) return 'sdk';
  if (ua.includes('@marginfront/mcp') || ua.includes('marginfront-mcp')) return 'mcp';
  // The code-cost-clarity forwarder sets: User-Agent: @marginfront/code-cost-clarity/<version>
  if (ua.includes('@marginfront/code-cost-clarity')) return 'ccc';
  // Browsers hitting the API directly (via the dashboard fetch layer).
  if (
    ua.includes('mozilla') ||
    ua.includes('chrome') ||
    ua.includes('safari') ||
    ua.includes('firefox')
  ) {
    return 'dashboard';
  }
  return 'api';
}
