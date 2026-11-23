import { IsString, IsOptional, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCheckoutSessionDto {
  @ApiProperty({
    description: 'Invoice ID to create checkout session for',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  invoiceId: string;

  @ApiProperty({
    description: 'Success redirect URL after payment',
    example: 'https://app.example.com/i/550e8400-e29b-41d4-a716-446655440000?paid=true',
    required: false,
  })
  @IsOptional()
  @IsUrl()
  successUrl?: string;

  @ApiProperty({
    description: 'Cancel redirect URL if payment is cancelled',
    example: 'https://app.example.com/i/550e8400-e29b-41d4-a716-446655440000?canceled=true',
    required: false,
  })
  @IsOptional()
  @IsUrl()
  cancelUrl?: string;
}
