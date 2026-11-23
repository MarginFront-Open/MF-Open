import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class ConnectAccountDto {
  @ApiProperty({ description: 'Authorization code from Stripe OAuth' })
  @IsString()
  code: string;

  @ApiProperty({ description: 'State parameter for security verification' })
  @IsString()
  state: string;
}
