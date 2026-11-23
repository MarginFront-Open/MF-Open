import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsBoolean, IsOptional, IsEnum, IsObject, MaxLength } from 'class-validator';

export enum PaymentProviderType {
  STRIPE = 'stripe',
}

export class CreatePaymentProviderDto {
  @ApiProperty({
    description: 'Provider type. Stripe is the only provider.',
    enum: PaymentProviderType,
  })
  @IsEnum(PaymentProviderType, {
    message: 'type must be "stripe". Stripe is the only payment provider this API supports.',
  })
  type: PaymentProviderType;

  @ApiProperty({ description: 'Provider name', required: false })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Provider code', required: false })
  @IsString()
  @MaxLength(50)
  @IsOptional()
  code?: string;

  @ApiProperty({ description: 'API key (required for Stripe)', required: false })
  @IsString()
  @IsOptional()
  apiKey?: string;

  @ApiProperty({ description: 'Secret key', required: false })
  @IsString()
  @IsOptional()
  secretKey?: string;

  @ApiProperty({ description: 'Webhook secret', required: false })
  @IsString()
  @IsOptional()
  webhookSecret?: string;

  @ApiProperty({ description: 'Set as default provider', required: false })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @ApiProperty({ description: 'Additional settings', required: false })
  @IsObject()
  @IsOptional()
  settings?: any;
}
