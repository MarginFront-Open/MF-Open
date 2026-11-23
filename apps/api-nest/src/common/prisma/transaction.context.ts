import { AsyncLocalStorage } from 'async_hooks';
import { PrismaClient } from '@prisma/client';

export const transactionContext = new AsyncLocalStorage<PrismaClient>();

/**
 * Get the current Prisma transaction client from async context
 * @returns PrismaClient | null - Current transaction client or null
 */
export const getCurrentTransaction = (): PrismaClient | null => {
  const transaction = transactionContext.getStore();

  if (!transaction) {
    return null;
  }

  return transaction;
};

/**
 * Check if we're currently in a transaction context
 * @returns boolean - Whether a transaction is active
 */
export const isInTransaction = (): boolean => {
  return !!transactionContext.getStore();
};

/**
 * Run a function within a transaction context
 * @param transaction - Prisma transaction client
 * @param callback - Function to run within transaction context
 * @returns Promise<T> - Result of the callback
 */
export const runInTransaction = async <T>(
  transaction: PrismaClient,
  callback: () => Promise<T>,
): Promise<T> => {
  return transactionContext.run(transaction, callback);
};
