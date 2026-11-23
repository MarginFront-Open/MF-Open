import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { CapModeDto, CapPeriodDto } from './create-cap-policy.dto';
import { IsAscendingThresholdLadder } from './alert-thresholds.validator';

/**
 * A cap's identity (org, scope, scopeValue, provider) is immutable — changing it
 * means a different cap, so it is not updatable here. Only the knobs a
 * decision-maker tunes on an existing cap are: amount, period, mode, cool-off.
 */
export class UpdateCapPolicyDto {
  @ApiPropertyOptional({ description: 'New cap amount in US dollars.', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(50_000_000)
  amountUsd?: number;

  @ApiPropertyOptional({ description: 'New reset cadence.', enum: CapPeriodDto })
  @IsOptional()
  @IsEnum(CapPeriodDto)
  period?: CapPeriodDto;

  @ApiPropertyOptional({ description: 'New enforcement posture.', enum: CapModeDto })
  @IsOptional()
  @IsEnum(CapModeDto)
  mode?: CapModeDto;

  @ApiPropertyOptional({
    description: 'New cool-off window in hours. Send 0 to clear.',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8760)
  coolOffHours?: number;

  @ApiPropertyOptional({
    description:
      'New alert ladder (whole percents, default 50/80/100). 1..100, at most 5 rungs, ' +
      'strictly ascending.',
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
