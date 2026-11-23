/**
 * Query utility functions for Prisma
 */
import { NotFoundException } from '@nestjs/common';

/**
 * Find entity or throw error if not found
 * @param model - Prisma model delegate
 * @param id - Entity ID
 * @param entityName - Name of entity for error message
 * @returns Found entity
 */
export const findEntityOrThrow = async <T>(
  model: any,
  id: string,
  entityName: string,
): Promise<T> => {
  if (!id) return null;

  const entity = await model.findUnique({
    where: { id },
  });

  if (!entity) {
    throw new NotFoundException(`${entityName} not found`);
  }

  return entity;
};

/**
 * Group array items by a key function (helper function)
 * @param array - Array to group
 * @param keyFn - Function to extract the grouping key
 * @returns Grouped items
 */
export const groupBy = <T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> => {
  return array.reduce(
    (result, item) => {
      const key = keyFn(item);
      if (!result[key]) {
        result[key] = [];
      }
      result[key].push(item);
      return result;
    },
    {} as Record<string, T[]>,
  );
};

/**
 * Build pagination options for Prisma queries
 * @param page - Page number (1-based)
 * @param limit - Items per page
 * @returns Prisma skip and take values
 */
export const buildPaginationOptions = (
  page: number = 1,
  limit: number = 10,
): { skip: number; take: number } => {
  const skip = (page - 1) * limit;
  const take = limit;

  return { skip, take };
};

/**
 * Build sort options for Prisma queries
 * @param sortBy - Field to sort by
 * @param sortOrder - Sort order (asc or desc)
 * @returns Prisma orderBy object
 */
export const buildSortOptions = (sortBy?: string, sortOrder: string = 'asc'): any => {
  if (!sortBy) {
    return { createdAt: 'desc' };
  }

  return { [sortBy]: sortOrder };
};

/**
 * Format paginated response
 * @param data - Data array
 * @param total - Total count
 * @param page - Current page
 * @param limit - Items per page
 * @returns Formatted response with pagination metadata
 */
export const formatPaginatedResponse = <T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): {
  results: T[];
  page: number;
  limit: number;
  totalPages: number;
  totalResults: number;
} => {
  return {
    results: data,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    totalResults: total,
  };
};
