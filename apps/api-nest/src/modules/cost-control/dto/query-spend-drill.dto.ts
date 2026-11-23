import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { CapPeriodDto } from './create-cap-policy.dto';

/**
 * The drill-down into ONE branch row of GET /control/spend/breakdown: the same
 * window, the same internal-coding filter, narrowed to a single branchKey and
 * split by (commit, teammate). branchKey is always required — with no branch
 * there is nothing to drill into.
 */
export class QuerySpendDrillDto {
  @ApiProperty({
    description: 'The period to sum spend over. The server computes the current window in UTC.',
    enum: CapPeriodDto,
  })
  @IsEnum(CapPeriodDto)
  period: CapPeriodDto;

  @ApiProperty({
    description:
      'The composite branch key to drill into, exactly as it appears in the breakdown rows: ' +
      '"<owner/repo>#<branch>" (a branch with no repo recorded keys as "#<branch>"). Only ' +
      'events whose git metadata resolves to this key are counted, so a branch named main in ' +
      'two repos never bleeds together.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  branchKey: string;
}
