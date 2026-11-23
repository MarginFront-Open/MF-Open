import { IsString, IsNumber, IsOptional, IsEnum, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRefundDto {
  @ApiProperty({
    description: 'Stripe Payment Intent ID to refund',
    example: 'pi_1234567890abcdef',
  })
  @IsString()
  paymentIntentId: string;

  @ApiProperty({
    description: 'Amount to refund in cents (optional, full refund if not provided)',
    example: 5000,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  amountCents?: number;

  @ApiProperty({
    description: 'Reason for the refund',
    enum: ['requested_by_customer', 'duplicate', 'fraudulent'],
    example: 'requested_by_customer',
    required: false,
  })
  @IsOptional()
  @IsEnum(['requested_by_customer', 'duplicate', 'fraudulent'])
  reason?: string;
}
