import { ApiProperty } from '@nestjs/swagger';
import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreatePricingStrategyDto } from './create-pricing-strategy.dto';

export class CreatePricingStrategiesBulkDto {
  @ApiProperty({
    description: 'Array of pricing strategies to create',
    type: [CreatePricingStrategyDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePricingStrategyDto)
  strategies: CreatePricingStrategyDto[];
}
