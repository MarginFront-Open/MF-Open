import { buildTrustedOrigins } from './cors';

describe('buildTrustedOrigins', () => {
  it('should trust localhost origins by default', () => {
    const origins = buildTrustedOrigins([]);
    expect(origins.isTrusted('http://localhost:3000')).toBe(true);
    expect(origins.isTrusted('http://localhost:4000')).toBe(true);
  });

  it('should trust configured CORS origins', () => {
    const origins = buildTrustedOrigins(['https://app.example.com', 'https://qa.example.com']);
    expect(origins.isTrusted('https://app.example.com')).toBe(true);
    expect(origins.isTrusted('https://qa.example.com')).toBe(true);
  });

  it('should reject unknown origins', () => {
    const origins = buildTrustedOrigins([]);
    expect(origins.isTrusted('https://evil.com')).toBe(false);
  });

  it('should filter out empty strings from config', () => {
    const origins = buildTrustedOrigins(['', 'https://app.example.com', '']);
    expect(origins.isTrusted('https://app.example.com')).toBe(true);
    expect(origins.isTrusted('')).toBe(false);
  });

  describe('wildcard patterns', () => {
    it('should match Vercel preview deployment URLs', () => {
      const origins = buildTrustedOrigins(['https://*-acme-team.vercel.app']);
      expect(origins.isTrusted('https://my-app-abc123-acme-team.vercel.app')).toBe(true);
      expect(origins.isTrusted('https://my-app-def456-acme-team.vercel.app')).toBe(true);
    });

    it('should not match origins that do not fit the wildcard', () => {
      const origins = buildTrustedOrigins(['https://*-acme-team.vercel.app']);
      expect(origins.isTrusted('https://evil.vercel.app')).toBe(false);
      expect(origins.isTrusted('https://acme-team.vercel.app')).toBe(false);
    });

    it('should not match partial or embedded origins', () => {
      const origins = buildTrustedOrigins(['https://*-acme-team.vercel.app']);
      expect(origins.isTrusted('https://fake-acme-team.vercel.app.evil.com')).toBe(false);
      expect(origins.isTrusted('http://prefix.https://x-acme-team.vercel.app')).toBe(false);
    });

    it('should work alongside exact matches', () => {
      const origins = buildTrustedOrigins([
        'https://app.example.com',
        'https://*-acme-team.vercel.app',
      ]);
      expect(origins.isTrusted('https://app.example.com')).toBe(true);
      expect(origins.isTrusted('https://my-app-ghi789-acme-team.vercel.app')).toBe(true);
      expect(origins.isTrusted('https://evil.com')).toBe(false);
    });
  });
});
