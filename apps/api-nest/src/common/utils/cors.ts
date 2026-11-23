const DEFAULT_ORIGINS = ['http://localhost:3000', 'http://localhost:4000'];

export interface TrustedOrigins {
  isTrusted(origin: string): boolean;
}

/**
 * Converts a wildcard pattern (e.g., "https://*-acme-team.vercel.app")
 * into a RegExp that matches the full origin string.
 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const withWildcard = escaped.replace(/\*/g, '[a-zA-Z0-9-]+');
  return new RegExp(`^${withWildcard}$`);
}

export function buildTrustedOrigins(configOrigins: string[]): TrustedOrigins {
  const allOrigins = [...DEFAULT_ORIGINS, ...configOrigins].filter(Boolean);
  const exactMatches = new Set<string>();
  const wildcardPatterns: RegExp[] = [];

  for (const origin of allOrigins) {
    if (origin.includes('*')) {
      wildcardPatterns.push(wildcardToRegex(origin));
    } else {
      exactMatches.add(origin);
    }
  }

  return {
    isTrusted(origin: string): boolean {
      if (exactMatches.has(origin)) return true;
      return wildcardPatterns.some((pattern) => pattern.test(origin));
    },
  };
}
