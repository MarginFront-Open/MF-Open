import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

// Analytics request bounds. The row cap's single home is
// @marginfront/db (it also caps getCostBreakdown pagination) — re-exported here
// so api-nest call sites keep one local import for both bounds.
export const ANALYTICS_MAX_WINDOW_DAYS = 366;
export { ANALYTICS_MAX_ROWS } from '@marginfront/db';

const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

function requestedWindowDays(start: unknown, end: unknown): number | null {
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.ceil((endMs - startMs) / MILLISECONDS_PER_DAY);
}

/**
 * Rejects date windows wider than `maxDays` with a 400. Decorate the END-date
 * property; `startProperty` names the matching start-date field on the same
 * DTO. Missing or malformed dates deliberately pass through — presence and
 * format are @IsDateString / @IsOptional's job, so each problem surfaces as
 * its own validation message instead of a misleading window error.
 */
export function MaxWindowDays(
  maxDays: number,
  startProperty = 'startDate',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxWindowDays',
      target: object.constructor,
      propertyName,
      constraints: [maxDays, startProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [max, startProp] = args.constraints as [number, string];
          const start = (args.object as Record<string, unknown>)[startProp];
          const days = requestedWindowDays(start, value);
          if (days === null) return true;
          return days <= max;
        },
        defaultMessage(args: ValidationArguments) {
          const [max, startProp] = args.constraints as [number, string];
          const start = (args.object as Record<string, unknown>)[startProp];
          const end = (args.object as Record<string, unknown>)[args.property];
          const days = requestedWindowDays(start, end);
          const supportEmail = process.env.SUPPORT_EMAIL?.trim();
          const largerExport = supportEmail
            ? `or contact ${supportEmail} if you need a larger data export.`
            : 'or split it into several smaller requests if you need a larger data export.';
          return (
            `Date window too large: requested ${days} days, maximum is ${max}. ` +
            `Narrow the ${startProp}/${args.property} range, ${largerExport}`
          );
        },
      },
    });
  };
}
