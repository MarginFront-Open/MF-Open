import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class CreditAlertsPauseDto {
  @ApiProperty({
    description:
      "true silences this subscription's credit-pool emails; false turns them back on. " +
      'Always send the state you want, never a toggle: two identical calls leave the ' +
      'subscription in the same place.',
    example: true,
  })
  @IsBoolean()
  paused: boolean;
}
