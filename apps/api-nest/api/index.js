/**
 * WHAT THIS FILE DOES: Vercel serverless entry for api-nest — imports the built
 * NestJS app and exports a handler that waits for initialization on cold start.
 * Every cold start logs the database HOSTNAME (never credentials), so you can
 * see whether traffic goes through a connection pooler or a direct connection
 * when DATABASE_URL is a write-only secret on your host.
 * CONNECTS TO: ../dist/main (built NestJS app), packages/db/prisma/schema.prisma
 * (the datasource that reads DATABASE_URL at runtime).
 */

// Set serverless environment before importing the app
process.env.VERCEL = '1';

// Hostname ONLY — never the full URL. On any parse failure this returns a fixed
// placeholder rather than echoing the input, so credentials can't leak through
// the error path either.
function databaseHostForLog(connectionString) {
  if (!connectionString) {
    return '(DATABASE_URL not set)';
  }
  try {
    return new URL(connectionString).hostname;
  } catch {
    return '(unparseable DATABASE_URL — host not logged)';
  }
}

let initPromise = null;
let expressServer = null;

async function initializeApp() {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const mainModule = require('../dist/main');

      expressServer = mainModule.default;
      const { getServerlessApp } = mainModule;

      if (typeof getServerlessApp === 'function') {
        await getServerlessApp();
        console.log('NestJS app initialized for serverless');
        // Hostname only; see the header.
        console.log(`DB host: ${databaseHostForLog(process.env.DATABASE_URL)}`);
      } else {
        throw new Error('getServerlessApp function not found');
      }

      return expressServer;
    } catch (error) {
      console.error('Failed to initialize NestJS:', error);
      throw error;
    }
  })();

  return initPromise;
}

// Handler that ensures NestJS is initialized before handling requests
const handler = async (req, res) => {
  try {
    const app = await initializeApp();
    return app(req, res);
  } catch (error) {
    console.error('Handler error:', error);
    res.status(500).json({
      error: 'Failed to initialize NestJS application',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
};

module.exports = handler;
// Test-only export — Vercel calls module.exports as the handler and ignores extra properties.
module.exports.databaseHostForLog = databaseHostForLog;
