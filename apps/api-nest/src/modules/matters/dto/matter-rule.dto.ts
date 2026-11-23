/**
 * WHAT THIS FILE DOES: Request DTOs for the matter routing-rule endpoints
 *The at-least-one-matcher rule and the trim-to-null matcher
 * normalization mirror the dashboard's upsertMatterRule and live in
 * matters.service.ts, so both surfaces reject with the same messages.
 *
 * CONNECTS TO: matters.controller.ts, matters.service.ts,
 * apps/dashboard/app/actions/matter-rules.ts (MatterRuleInput, the shape
 * being mirrored).
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMatterRuleDto {
  @ApiProperty({ description: 'The matter this rule assigns events to (UUID)' })
  @IsUUID()
  matterId: string;

  @ApiPropertyOptional({
    description: 'Evaluation priority; lower runs first. Defaults to 100.',
    default: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ description: 'Exact agent code to match' })
  @IsOptional()
  @IsString()
  agentCode?: string | null;

  @ApiPropertyOptional({ description: 'Exact customer external ID to match' })
  @IsOptional()
  @IsString()
  customerExternalId?: string | null;

  @ApiPropertyOptional({
    description: 'Case-insensitive substring to match against the signal name',
  })
  @IsOptional()
  @IsString()
  signalPattern?: string | null;
}

export class UpdateMatterRuleDto {
  @ApiPropertyOptional({ description: 'Move the rule to another matter (UUID)' })
  // Not @IsOptional — it also skips validators for null, sending an explicit
  // null to Prisma as a 500. A rule always targets a matter, so null must 400.
  @ValidateIf((dto: UpdateMatterRuleDto) => dto.matterId !== undefined)
  @IsUUID()
  matterId?: string;

  @ApiPropertyOptional({ description: 'Evaluation priority; lower runs first.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ description: 'Exact agent code to match; null clears it' })
  @IsOptional()
  agentCode?: string | null;

  @ApiPropertyOptional({ description: 'Exact customer external ID to match; null clears it' })
  @IsOptional()
  customerExternalId?: string | null;

  @ApiPropertyOptional({
    description: 'Case-insensitive signal-name substring; null clears it',
  })
  @IsOptional()
  signalPattern?: string | null;
}
