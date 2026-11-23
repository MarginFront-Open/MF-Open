import { PartialType } from '@nestjs/swagger';
import { IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import {
  CreatePricingStrategyDto,
  CreditPoolInputDto,
  PricingTierDto,
} from './create-pricing-strategy.dto';

// PartialType doesn't carry over the @Type() decorator from the parent class,
// so class-transformer doesn't know how to handle the tier objects on updates —
// it turns [{lower:0, upper:100, rate:50}] into [[]]. We fix that by explicitly
// re-declaring the tiers field with the correct @Type decorator.
// creditPool is nested too, so a PATCH carrying it would arrive as {} and the
// pool would silently not change — re-declared for the same reason.
export class UpdatePricingStrategyDto extends PartialType(CreatePricingStrategyDto) {
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PricingTierDto)
  tiers?: PricingTierDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CreditPoolInputDto)
  creditPool?: CreditPoolInputDto;
}
