import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class QuickOnboardingDto {
  @ApiProperty({
    description: 'Organization ID to onboard',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({
    description: 'Industry/business type',
    example: 'SaaS',
    required: false,
  })
  @IsOptional()
  @IsString()
  industry?: string;
}
