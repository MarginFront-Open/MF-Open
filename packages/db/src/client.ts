import { PrismaClient } from '@prisma/client';

/**
 * Singleton Prisma Client for MarginFront Platform
 *
 * This ensures we maintain a single database connection across the application,
 * preventing connection pool exhaustion in development (hot reload) and production.
 *
 * @see https://www.prisma.io/docs/guides/performance-and-optimization/connection-management
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
    errorFormat: 'pretty',
  });

globalForPrisma.prisma = db;

export async function disconnectDb() {
  await db.$disconnect();
}

export async function connectDb() {
  await db.$connect();
}
