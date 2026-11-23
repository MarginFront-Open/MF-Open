import { IsArray, ArrayMinSize, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DeleteSignalEventsDto {
  @ApiProperty({
    description: 'Array of event IDs to delete',
    example: ['123e4567-e89b-12d3-a456-426614174010', '123e4567-e89b-12d3-a456-426614174011'],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('4', { each: true })
  eventIds: string[];
}
