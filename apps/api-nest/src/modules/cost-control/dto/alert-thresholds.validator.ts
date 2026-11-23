import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * The alert ladder must be a strictly-ascending list
 * of rungs. Strictly-ascending also dedups (equal neighbours are rejected), which
 * is the "dedup" bound. The 1..100 range, whole-integer, and
 * "<=5 entries" bounds are the standard class-validator decorators alongside this
 * one; ordering is the one rule they can't express, so it lives here.
 */
export function IsAscendingThresholdLadder(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAscendingThresholdLadder',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === undefined) return true; // absence is handled by @IsOptional
          if (!Array.isArray(value) || value.length === 0) return false;
          for (let i = 1; i < value.length; i++) {
            if (!(value[i] > value[i - 1])) return false;
          }
          return true;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be whole percents in strictly ascending order (e.g. [50, 80, 100]).`;
        },
      },
    });
  };
}
