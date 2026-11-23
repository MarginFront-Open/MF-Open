import { AsyncLocalStorage } from 'async_hooks';
import { PrismaClient } from '@prisma/client';

/**
 * AsyncLocalStorage for storing the current Prisma transaction
 * This allows implicit transaction passing throughout the request lifecycle
 */
export const transactionContext = new AsyncLocalStorage<PrismaClient>();

/**
 * Get the current transaction (Prisma Client) from AsyncLocalStorage
 * @returns {PrismaClient | null} - Current transaction client or null
 */
export const getCurrentTransaction = (): PrismaClient | null => {
  const transaction = transactionContext.getStore();

  if (!transaction) {
    return null;
  }

  return transaction;
};

/**
 * Execute code within a transaction context
 * @param transaction - Prisma transaction client
 * @param callback - Code to execute within transaction context
 */
export const runInTransactionContext = <T>(transaction: PrismaClient, callback: () => T): T => {
  return transactionContext.run(transaction, callback);
};

/**
 * Check if currently running within a transaction context
 * @returns {boolean}
 */
export const hasActiveTransaction = (): boolean => {
  return transactionContext.getStore() !== undefined;
};
