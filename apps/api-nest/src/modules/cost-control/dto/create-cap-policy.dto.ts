import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsIn,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsAscendingThresholdLadder } from './alert-thresholds.validator';

export enum CapScopeDto {
  ORG = 'org',
  TEAM = 'team',
  DEV = 'dev',
}

export enum CapPeriodDto {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export enum CapModeDto {
  TRACK = 'track',
  ENFORCE = 'enforce',
}

export class CreateCapPolicyDto {
  @ApiProperty({
    description: 'Who this cap governs: the org ceiling or one teammate.',
    enum: [CapScopeDto.ORG, CapScopeDto.DEV],
  })
  @IsIn([CapScopeDto.ORG, CapScopeDto.DEV], {
    message: "MarginFront doesn't have teams yet. Use a whole-team cap or a per-teammate cap.",
  })
  scope: CapScopeDto;

  @ApiPropertyOptional({
    description:
      "The scope's target. Required for dev (the teammate's customerExternalId / " +
      'email). Omit for org.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  scopeValue?: string;

  @ApiProperty({
    description: "Must be 'all' — v1 caps cover all AI tools.",
    example: 'all',
  })
  @IsIn(['all'], {
    message: 'Caps cover all AI tools for now.',
  })
  providerScope: string;

  @ApiProperty({
    description: 'Cap amount in US dollars.',
    example: 200,
    minimum: 0,
    maximum: 50_000_000,
  })
  @IsNumber()
  @Min(0)
  @Max(50_000_000)
  amountUsd: number;

  @ApiProperty({ description: 'Reset cadence. Windows roll at UTC.', enum: CapPeriodDto })
  @IsEnum(CapPeriodDto)
  period: CapPeriodDto;

  @ApiProperty({
    description: "'track' watches and alerts (blocks nothing); 'enforce' hard-stops device-side.",
    enum: CapModeDto,
  })
  @IsEnum(CapModeDto)
  mode: CapModeDto;

  @ApiPropertyOptional({
    description:
      'Optional cool-off window in hours after a cap trips before the device re-evaluates.',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8760)
  coolOffHours?: number;

  @ApiPropertyOptional({
    description:
      'The alert ladder: whole percents of this cap at which a heads-up email fires ' +
      '(default 50/80/100). 1..100, at most 5 rungs, strictly ascending.',
    example: [50, 80, 100],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100, { each: true })
  @IsAscendingThresholdLadder()
  alertThresholds?: number[];
}
