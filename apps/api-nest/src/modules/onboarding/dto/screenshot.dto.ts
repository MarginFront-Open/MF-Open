import { IsString, IsUrl, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ScreenshotDto {
  @ApiProperty({
    description: 'Website URL to capture screenshot',
    example: 'https://example.com',
  })
  @IsString()
  @IsUrl()
  @IsNotEmpty()
  websiteUrl: string;
}

export class ScreenshotResponseDto {
  @ApiProperty({
    description: 'Screenshot URL (null if capture failed)',
    example: 'https://cdn.example.com/screenshot.png',
    nullable: true,
  })
  screenshotUrl: string | null;
}
