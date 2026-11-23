import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateFromPreviewDto {
  @ApiProperty({
    description: 'Organization ID to update',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({ description: 'Preview data - any structure accepted' })
  previewData: any;
}

export class CreateFromPreviewResponseDto {
  @ApiProperty()
  organization: any;

  @ApiProperty()
  agents: any[];

  @ApiProperty()
  signals: any[];

  @ApiProperty()
  pricingPlans: any[];

  @ApiProperty({ required: false })
  customers?: any[];

  @ApiProperty()
  summary: {
    agentsCreated: number;
    signalsCreated: number;
    plansCreated: number;
    customersCreated: number;
  };
}
