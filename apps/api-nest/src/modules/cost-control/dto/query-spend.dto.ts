import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CapPeriodDto } from './create-cap-policy.dto';

export class QuerySpendDto {
  @ApiProperty({
    description: 'The period to sum spend over. The server computes the current window in UTC.',
    enum: CapPeriodDto,
  })
  @IsEnum(CapPeriodDto)
  period: CapPeriodDto;

  @ApiPropertyOptional({
    description:
      "The teammate's customerExternalId (email). When present, the response includes that " +
      "teammate's spend alongside the org total; when absent, only the org total is returned.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerExternalId?: string;
}
