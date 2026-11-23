import { IsString, IsOptional, IsIn, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({
    description: 'User full name',
    example: 'John Doe',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @ApiProperty({
    description: 'User persona — their role/function, used for analytics and UX personalization',
    enum: [
      'founder',
      'finance',
      'gtm_sales',
      'product_engineering',
      'ops',
      'investor_advisor',
      'other',
    ],
    required: false,
  })
  @IsOptional()
  @IsIn([
    'founder',
    'finance',
    'gtm_sales',
    'product_engineering',
    'ops',
    'investor_advisor',
    'other',
  ])
  persona?: string;
}
