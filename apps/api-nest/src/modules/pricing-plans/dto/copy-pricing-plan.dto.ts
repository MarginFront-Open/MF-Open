import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNotEmpty,
  MaxLength,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export class CopyPricingPlanDto {
  @ApiProperty({
    description: 'New pricing plan name',
    example: 'Annual Pro Plan',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  newName: string;

  @ApiPropertyOptional({
    description: 'New pricing plan description',
    example: 'Annual version of Pro Plan with discount',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  newDescription?: string;

  @ApiPropertyOptional({
    description: 'Discount percentage to apply (0-100)',
    example: 20,
    default: 0,
    minimum: 0,
    maximum: 100,
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  discount?: number = 0;

  @ApiPropertyOptional({
    description: 'Convert monthly billing to yearly',
    example: true,
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  requestedYearly?: boolean = false;
}
