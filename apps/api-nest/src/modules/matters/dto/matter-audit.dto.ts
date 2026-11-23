/**
 * WHAT THIS FILE DOES: Query DTO for GET /v1/matters/audit, the
 * org-wide windowed reconciliation surface mirroring the dashboard's
 * getMatterExport.
 *
 * CONNECTS TO: matters.controller.ts, matters.service.ts,
 * matters-audit.util.ts (window semantics + grouping).
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsUUID,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

export const AUDIT_FORMATS = ['summary', 'detail'] as const;
export type AuditFormat = (typeof AUDIT_FORMATS)[number];

/**
 * Mirrors parseAuditWindow's exact transform (matters-audit.util.ts) and
 * rejects what comes out Invalid Date, so nothing that passes can 500 inside
 * the util and the util stays an untouched port of the dashboard parser. Do
 * not tighten this to strict ISO: REST would 400 windows the dashboard accepts.
 */
function IsAuditWindowDate(validationOptions?: ValidationOptions) {
  return (target: object, propertyName: string) => {
    registerDecorator({
      name: 'isAuditWindowDate',
      target: target.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          const candidate = value.includes('T') ? value : `${value}T00:00:00.000Z`;
          return !Number.isNaN(new Date(candidate).getTime());
        },
      },
    });
  };
}

export class MatterAuditQueryDto {
  @ApiPropertyOptional({
    description:
      'Window start, "YYYY-MM-DD" (start of day UTC) or full ISO timestamp. ' +
      'Defaults to 30 days back.',
  })
  @IsOptional()
  @IsAuditWindowDate({
    message:
      'start must be a date like "2026-09-01" (YYYY-MM-DD) or a full ISO timestamp ' +
      'like "2026-09-01T14:30:00Z".',
  })
  start?: string;

  @ApiPropertyOptional({
    description:
      'Window end, "YYYY-MM-DD" (end of day UTC, capped at now) or full ISO ' +
      'timestamp. Defaults to now.',
  })
  @IsOptional()
  @IsAuditWindowDate({
    message:
      'end must be a date like "2026-09-30" (YYYY-MM-DD) or a full ISO timestamp ' +
      'like "2026-09-30T14:30:00Z".',
  })
  end?: string;

  @ApiPropertyOptional({
    description:
      "'summary' = one row per matter + Unassigned + totals (the reconciliation " +
      "view); 'detail' adds one row per event.",
    enum: AUDIT_FORMATS,
    default: 'summary',
  })
  @IsOptional()
  @IsEnum(AUDIT_FORMATS)
  format?: AuditFormat;

  @ApiPropertyOptional({
    description:
      "Slice to one matter (UUID). Note the sliced view isn't the reconciliation " +
      'surface: Unassigned and org totals only appear on the unfiltered call.',
  })
  @IsOptional()
  @IsUUID()
  matterId?: string;
}
