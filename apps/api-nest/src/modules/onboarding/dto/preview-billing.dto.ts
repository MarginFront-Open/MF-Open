import { IsString, IsUrl, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PreviewBillingDto {
  @ApiProperty({
    description: 'Website URL to analyze',
    example: 'https://example.com',
  })
  @IsString()
  @IsUrl()
  @IsNotEmpty()
  websiteUrl: string;
}
