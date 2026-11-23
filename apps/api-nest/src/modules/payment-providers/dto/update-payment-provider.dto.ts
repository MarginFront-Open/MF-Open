import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsBoolean, IsOptional, IsObject, MaxLength } from 'class-validator';

export class UpdatePaymentProviderDto {
  @ApiProperty({ description: 'Provider name', required: false })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Set as default provider', required: false })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @ApiProperty({ description: 'Active status', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({ description: 'Additional settings', required: false })
  @IsObject()
  @IsOptional()
  settings?: any;
}
