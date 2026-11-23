/**
 * securityHeadersMiddleware.
 *
 * Boots a bare Express app — the serverless SHAPE, an Express instance — applies the
 * REAL middleware (imported, not re-declared),
 * and asserts helmet headers land on API paths and are skipped for Swagger.
 */
import express from 'express';
import type { Server } from 'http';
import { securityHeadersMiddleware } from './security-headers';

describe('securityHeadersMiddleware', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(securityHeadersMiddleware());
    app.get('/v1/usage/record', (_req, res) => res.status(200).json({ ok: true }));
    app.get('/api-docs', (_req, res) => res.status(200).send('docs'));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sets helmet headers on a normal API path (the serverless shape included)', async () => {
    const res = await fetch(`${baseUrl}/v1/usage/record`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('skips helmet on Swagger paths so the docs UI keeps working', async () => {
    const res = await fetch(`${baseUrl}/api-docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});
