import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';

export class CreateCreditTopupDto {
  @ApiProperty({
    description:
      'How many usage units to add to the pool. The same units the plan sells and the ' +
      'invoice bills, never dollars.',
    example: 1000,
  })
  @IsNumber()
  @IsPositive({ message: 'A top-up has to add at least some units. Enter a number above zero.' })
  units: number;

  @ApiProperty({
    description:
      'Your own key for this top-up. Send the same key again and you get the SAME grant ' +
      'back instead of a second one, so a retry can never double-credit a customer.',
    maxLength: 255,
    example: 'topup-2026-07-28-acme-1',
  })
  @IsString()
  // An empty key would pass @IsString and then match every other empty key,
  // so the SECOND top-up would silently replay the first one forever.
  @IsNotEmpty({
    message:
      'idempotencyKey cannot be blank. Send a value unique to this top-up (a UUID works) ' +
      'so a retry returns the same credit instead of adding a second one.',
  })
  @MaxLength(255)
  idempotencyKey: string;

  @ApiPropertyOptional({
    description:
      'Why you added these units. Stored on the grant itself, so "why does this customer ' +
      'have extra credits?" is answered from the ledger row.',
    example: 'Goodwill credit after a service issue',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
