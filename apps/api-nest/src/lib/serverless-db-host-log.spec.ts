/**
 * WHAT THIS FILE DOES: unit-tests the hostname extraction behind the cold-start
 * "DB host:" log line in api/index.js (the serverless entry shim).
 * WHY IT EXISTS: that log line is the only readable trace of a database URL
 * stored as a write-only host secret. The one thing it must never do is leak credentials,
 * so every URL shape here asserts the output contains no username or password —
 * including the parse-failure path, which must return a fixed placeholder
 * instead of echoing its input.
 * CONNECTS TO: apps/api-nest/api/index.js (module under test).
 */

// The shim sets process.env.VERCEL = '1' at import time; restore it afterward
// so this spec can't bleed serverless behavior into other tests in the worker.
const vercelEnvBeforeImport = process.env.VERCEL;

const { databaseHostForLog } = require('../../api/index') as {
  databaseHostForLog: (connectionString?: string) => string;
};

afterAll(() => {
  if (vercelEnvBeforeImport === undefined) {
    delete process.env.VERCEL;
  } else {
    process.env.VERCEL = vercelEnvBeforeImport;
  }
});

describe('databaseHostForLog', () => {
  const password = 'npg_FAKEsecret123';
  const user = 'neondb_owner';

  it('returns only the hostname for a pooled Neon URL', () => {
    const result = databaseHostForLog(
      `postgresql://${user}:${password}@ep-cool-name-a5xyz-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`,
    );
    expect(result).toBe('ep-cool-name-a5xyz-pooler.us-east-2.aws.neon.tech');
  });

  it('strips port, database name, and query params from a direct URL', () => {
    const result = databaseHostForLog(
      `postgresql://${user}:${password}@ep-cool-name-a5xyz.us-east-2.aws.neon.tech:5432/neondb?sslmode=require&channel_binding=require`,
    );
    expect(result).toBe('ep-cool-name-a5xyz.us-east-2.aws.neon.tech');
  });

  it('never leaks a password containing an unencoded @', () => {
    // split('@')[1] on this shape would return a password fragment ("ss").
    // new URL() takes the host after the LAST @, which is why we use it.
    const result = databaseHostForLog('postgresql://user:p@ss@host.example.com/db');
    expect(result).toBe('host.example.com');
    expect(result).not.toContain('ss@');
    expect(result).not.toContain('user');
  });

  it('returns a fixed placeholder for an unparseable value instead of echoing it', () => {
    const garbage = `total garbage with a secret ${password} inside`;
    const result = databaseHostForLog(garbage);
    expect(result).toBe('(unparseable DATABASE_URL — host not logged)');
    expect(result).not.toContain(password);
  });

  it('says so plainly when DATABASE_URL is not set', () => {
    expect(databaseHostForLog(undefined)).toBe('(DATABASE_URL not set)');
    expect(databaseHostForLog('')).toBe('(DATABASE_URL not set)');
  });

  it('never includes credentials in any output', () => {
    const shapes = [
      `postgresql://${user}:${password}@ep-a.us-east-2.aws.neon.tech/neondb`,
      `postgresql://${user}:${password}@ep-a-pooler.us-east-2.aws.neon.tech/neondb?pgbouncer=true&connect_timeout=15`,
      `${user}:${password}`,
      undefined,
    ];
    for (const shape of shapes) {
      const result = databaseHostForLog(shape);
      expect(result).not.toContain(password);
      expect(result).not.toContain(user);
    }
  });
});
