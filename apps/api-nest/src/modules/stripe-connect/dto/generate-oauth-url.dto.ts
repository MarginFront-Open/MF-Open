import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class GenerateOAuthUrlDto {
  @ApiPropertyOptional({ description: 'Redirect URI after OAuth completion' })
  @IsOptional()
  @IsString()
  redirectUri?: string;
}
