import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsNotEmpty, MaxLength, IsObject } from 'class-validator';

export class CreateAgentDto {
  @ApiProperty({
    description: 'Agent name',
    example: 'Customer Support Agent',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    description: 'Agent description',
    example: 'Handles customer support inquiries',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    description: 'Unique agent code',
    example: 'CS-001',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  agentCode: string;

  @ApiPropertyOptional({
    description: 'Whether the agent is active',
    example: true,
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Additional context/metadata for the agent',
    example: { department: 'support', tier: 1 },
  })
  @IsObject()
  @IsOptional()
  context?: Record<string, any>;
}
