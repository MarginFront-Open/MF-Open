import { IsString, IsUrl, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ExtractDataDto {
  @ApiProperty({
    description: 'Website URL to extract data from',
    example: 'https://example.com',
  })
  @IsString()
  @IsUrl()
  @IsNotEmpty()
  websiteUrl: string;
}

export class ExtractDataResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty()
  data: {
    name: string;
    description: string;
    industry?: string;
    logo?: string;
    website: string;
    contact?: {
      email?: string;
      phone?: string;
    };
  };
}
