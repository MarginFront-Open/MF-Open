/**
 * WHAT THIS FILE DOES: Request DTOs for the matter CRUD + list endpoints
 *Types and bounds only — the trim/empty/duplicate checks that
 * mirror the dashboard's upsertMatter live in matters.service.ts so the two
 * surfaces reject with the same messages.
 *
 * CONNECTS TO: matters.controller.ts (binds these), matters.service.ts (the
 * parity validation), apps/dashboard/app/actions/matters.ts (MatterInput, the
 * shape being mirrored).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export const MATTER_STATUSES = ['open', 'closed'] as const;
export type MatterStatus = (typeof MATTER_STATUSES)[number];

export class CreateMatterDto {
  @ApiProperty({
    description:
      "The firm's own case identifier, unique per organization. Matched exactly " +
      '(trimmed) against metadata.matterId at ingest.',
  })
  @IsString()
  matterNumber: string;

  @ApiProperty({ description: 'Matter name, e.g. the case caption' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'The client this matter is billed to' })
  @IsString()
  clientName: string;

  @ApiPropertyOptional({ description: 'Matter status', enum: MATTER_STATUSES, default: 'open' })
  @IsOptional()
  @IsEnum(MATTER_STATUSES)
  status?: MatterStatus;

  @ApiPropertyOptional({
    description: 'Responsible timekeeper (user UUID). Passed through unchanged.',
  })
  @IsOptional()
  @IsUUID()
  responsibleUserId?: string | null;
}

export class UpdateMatterDto {
  @ApiPropertyOptional({ description: 'New matter number (unique per organization)' })
  @IsOptional()
  @IsString()
  matterNumber?: string;

  @ApiPropertyOptional({ description: 'New matter name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'New client name' })
  @IsOptional()
  @IsString()
  clientName?: string;

  @ApiPropertyOptional({ description: 'Matter status', enum: MATTER_STATUSES })
  @IsOptional()
  @IsEnum(MATTER_STATUSES)
  status?: MatterStatus;

  @ApiPropertyOptional({
    description: 'Responsible timekeeper (user UUID); null clears it.',
  })
  // null is the documented "clear it" value — validate only present, non-null
  // values, or @IsOptional lets junk strings through to a Prisma cast 500.
  @ValidateIf(
    (dto: UpdateMatterDto) => dto.responsibleUserId !== undefined && dto.responsibleUserId !== null,
  )
  @IsUUID()
  responsibleUserId?: string | null;
}

/** Shared page/limit query for the three list endpoints (matters, unassigned
 * events, routing rules) — same shape and defaults as /v1/customers. */
export class MatterListQueryDto {
  @ApiPropertyOptional({ description: 'Items per page', minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;
}
