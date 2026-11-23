import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { CapPeriodDto } from './create-cap-policy.dto';

/**
 * The two breakdown grains the platform can honestly serve. There is
 * deliberately NO 'pr' value: the pipeline records repo/branch/commitSha, not
 * pull-request numbers, and offering a PR
 * option that silently means "branch" would be a lie in the API surface.
 */
export enum SpendBreakdownDimensionDto {
  REPO = 'repo',
  BRANCH = 'branch',
}

export class QuerySpendBreakdownDto {
  @ApiProperty({
    description: 'The period to sum spend over. The server computes the current window in UTC.',
    enum: CapPeriodDto,
  })
  @IsEnum(CapPeriodDto)
  period: CapPeriodDto;

  @ApiProperty({
    description:
      "Group spend by 'repo' (one row per repository) or 'branch' (one row per repo#branch, " +
      'so a branch named main in two repos stays two rows).',
    enum: SpendBreakdownDimensionDto,
  })
  @IsEnum(SpendBreakdownDimensionDto)
  dimension: SpendBreakdownDimensionDto;
}
