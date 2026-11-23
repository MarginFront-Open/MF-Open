import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, ValidateNested, IsOptional, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';
import { CreatePricingStrategyDto } from './create-pricing-strategy.dto';
import { UpdatePricingStrategyDto } from './update-pricing-strategy.dto';

export class StrategyUpdateItem extends UpdatePricingStrategyDto {
  @ApiProperty({
    description: 'ID of the strategy to update',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  id: string;
}

export class StrategiesData {
  @ApiPropertyOptional({
    description: 'Array of new strategies to create',
    type: [CreatePricingStrategyDto],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreatePricingStrategyDto)
  new?: CreatePricingStrategyDto[];

  @ApiPropertyOptional({
    description: 'Array of existing strategies to update',
    type: [StrategyUpdateItem],
  })
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StrategyUpdateItem)
  update?: StrategyUpdateItem[];
}

export class BulkUpdatePricingStrategiesDto {
  @ApiProperty({
    description: 'Strategies object containing new and update arrays',
    example: {
      new: [
        {
          name: 'New Strategy',
          agentId: '123e4567-e89b-12d3-a456-426614174000',
          chargeType: 'usage',
          pricingModel: 'flat',
          rate: 0.01,
        },
      ],
      update: [
        {
          id: '123e4567-e89b-12d3-a456-426614174001',
          rate: 0.02,
        },
      ],
    },
  })
  @ValidateNested()
  @Type(() => StrategiesData)
  strategies: StrategiesData;
}
