import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNotEmpty,
  MaxLength,
  IsUUID,
  IsObject,
} from 'class-validator';

export class CreatePricingPlanDto {
  @ApiProperty({
    description: 'Pricing plan name',
    example: 'Pro Plan',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    description: 'Pricing plan description',
    example: 'Professional tier with advanced features',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({
    description: 'List of features included in this plan',
    example: { features: ['API Access', 'Advanced Analytics', 'Priority Support'] },
  })
  @IsObject()
  @IsOptional()
  featuresList?: Record<string, any>;

  @ApiPropertyOptional({
    description:
      'Agent ID to link this plan to. Optional — plans are org-level and can be linked to multiple agents via the /agents endpoint.',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @IsOptional()
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Whether the pricing plan is active',
    example: true,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
