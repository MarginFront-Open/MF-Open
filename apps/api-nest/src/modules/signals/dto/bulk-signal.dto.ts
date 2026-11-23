import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsBoolean,
  IsUUID,
  IsOptional,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreateSignalDto } from './create-signal.dto';

export class BulkSignalItem extends CreateSignalDto {
  @ApiProperty({
    description: 'Signal ID (required when isNew is false)',
    example: '123e4567-e89b-12d3-a456-426614174005',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  id?: string;

  @ApiProperty({
    description:
      'Whether this is a new signal to create (true) or existing signal to update (false)',
    example: true,
  })
  @IsBoolean()
  isNew: boolean;
}

export class BulkSignalDto {
  @ApiProperty({
    description: 'Array of signals to create or update',
    type: [BulkSignalItem],
    minItems: 1,
    maxItems: 50,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkSignalItem)
  signals: BulkSignalItem[];
}
