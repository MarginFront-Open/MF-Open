import moment from 'moment';
import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';

/**
 * Get date grouping SQL for PostgreSQL
 * @param groupBy - Time grouping (daily, weekly, monthly)
 * @param dateColumnName - The column name to apply grouping to
 * @returns Prisma raw SQL for date grouping
 */
export const getDateGroupingRaw = (
  groupBy: string,
  dateColumnName: string = 'usageDate',
): Prisma.Sql => {
  switch (groupBy) {
    case 'daily':
      return Prisma.sql`DATE(${Prisma.raw(dateColumnName)})`;
    case 'weekly':
      return Prisma.sql`date_trunc('week', ${Prisma.raw(dateColumnName)})`;
    case 'monthly':
      return Prisma.sql`date_trunc('month', ${Prisma.raw(dateColumnName)})`;
    case 'quarterly':
      return Prisma.sql`date_trunc('quarter', ${Prisma.raw(dateColumnName)})`;
    case 'yearly':
      return Prisma.sql`date_trunc('year', ${Prisma.raw(dateColumnName)})`;
    default:
      return Prisma.sql`DATE(${Prisma.raw(dateColumnName)})`;
  }
};

/**
 * Get date format string for PostgreSQL queries
 * @param groupBy - Time grouping (daily, weekly, monthly)
 * @param columnName - Name of the date column
 * @returns Format object with dateFormat and raw SQL string
 */
export const getDateFormat = (
  groupBy: string,
  columnName: string = 'invoiceDate',
): { dateFormat: string; dateQuerySql: string } => {
  let dateFormat: string;
  let dateQuerySql: string;

  switch (groupBy) {
    case 'daily':
      dateFormat = 'YYYY-MM-DD';
      dateQuerySql = `to_char(${columnName}, 'YYYY-MM-DD')`;
      break;
    case 'weekly':
      dateFormat = 'YYYY-"W"WW';
      dateQuerySql = `to_char(date_trunc('week', ${columnName}), 'YYYY-"W"WW')`;
      break;
    case 'monthly':
      dateFormat = 'YYYY-MM';
      dateQuerySql = `to_char(${columnName}, 'YYYY-MM')`;
      break;
    case 'quarterly':
      dateFormat = 'YYYY-"Q"Q';
      dateQuerySql = `to_char(${columnName}, 'YYYY-"Q"Q')`;
      break;
    case 'yearly':
      dateFormat = 'YYYY';
      dateQuerySql = `to_char(${columnName}, 'YYYY')`;
      break;
    default:
      dateFormat = 'YYYY-MM-DD';
      dateQuerySql = `to_char(${columnName}, 'YYYY-MM-DD')`;
  }

  return { dateFormat, dateQuerySql };
};

/**
 * Create a date range filter for Prisma queries
 * @param startDate - Start date (YYYY-MM-DD)
 * @param endDate - End date (YYYY-MM-DD)
 * @param columnName - The column name to apply range to (defaults to 'usageDate')
 * @returns Where clause for date range
 */
export const createDateRangeFilter = (
  startDate: string,
  endDate: string,
  columnName: string = 'usageDate',
): any => {
  if (!startDate || !endDate) {
    throw new Error('Start date and end date are required');
  }

  if (
    !moment(startDate, 'YYYY-MM-DD', true).isValid() ||
    !moment(endDate, 'YYYY-MM-DD', true).isValid()
  ) {
    throw new Error('Invalid date format. Use YYYY-MM-DD');
  }

  return {
    [columnName]: {
      gte: moment(startDate).startOf('day').toDate(),
      lte: moment(endDate).endOf('day').toDate(),
    },
  };
};

/**
 * Generate a complete date range from start to end date
 * @param startDate - Start date
 * @param endDate - End date
 * @returns Array of dates in YYYY-MM-DD format
 */
export const generateDateRange = (startDate: string, endDate: string): string[] => {
  const dateRange: string[] = [];
  const currentDate = moment(startDate);
  const endMoment = moment(endDate);

  while (currentDate.isSameOrBefore(endMoment)) {
    dateRange.push(currentDate.format('YYYY-MM-DD'));
    currentDate.add(1, 'days');
  }

  return dateRange;
};

/**
 * Calculate date difference in days/months/years
 * @param startDate - Start date
 * @param endDate - End date
 * @param unit - Unit of measurement (days, months, years)
 * @returns Difference in specified units
 */
export const dateDiff = (
  startDate: Date | string,
  endDate: Date | string,
  unit: moment.unitOfTime.Diff = 'days',
): number => {
  return moment(endDate).diff(moment(startDate), unit);
};

/**
 * Format a date for display
 * @param date - Date to format
 * @param format - Format string (default: YYYY-MM-DD)
 * @returns Formatted date string
 */
export const formatDate = (date: Date | string, format: string = 'YYYY-MM-DD'): string => {
  return moment(date).format(format);
};

/**
 * Calculate billing period for a subscription
 * @param params - Calculation parameters
 * @returns Billing period start and end dates
 */
export const calculateBillingPeriod = (params: {
  startDate: Date;
  billingCycle: string;
  customCycleDays?: number;
  timezone?: string;
}): { billingPeriodStart: Date; billingPeriodEnd: Date } => {
  const { startDate, billingCycle, customCycleDays, timezone = 'UTC' } = params;

  const validStartDate =
    startDate instanceof Date && !isNaN(startDate.getTime()) ? startDate : new Date();

  let startDt = DateTime.fromJSDate(validStartDate).setZone(timezone);

  if (!startDt.isValid) {
    startDt = DateTime.fromJSDate(validStartDate).setZone('UTC');
  }

  let endDt: DateTime;

  switch (billingCycle) {
    case 'yearly':
      endDt = startDt.plus({ years: 1 }).minus({ seconds: 1 });
      break;
    case 'custom':
      if (customCycleDays && customCycleDays > 0) {
        endDt = startDt.plus({ days: customCycleDays }).minus({ seconds: 1 });
      } else {
        endDt = startDt.plus({ months: 1 }).minus({ seconds: 1 });
      }
      break;
    case 'monthly':
    default:
      endDt = startDt.plus({ months: 1 }).minus({ seconds: 1 });
      break;
  }

  if (!endDt.isValid) {
    endDt = startDt.plus({ days: 30 });
  }

  return {
    billingPeriodStart: startDt.toUTC().toJSDate(),
    billingPeriodEnd: endDt.toUTC().toJSDate(),
  };
};
