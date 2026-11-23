import { ApiProperty } from '@nestjs/swagger';

/**
 * The response shape of GET /v1/control/coverage.
 *
 * Documentation only — this route is a read and validates nothing, so these classes
 * exist so the OpenAPI contract is STRUCTURAL rather than a prose paragraph.
 */
export class ToolCoverageDto {
  @ApiProperty({
    description:
      'Teammates whose every machine seen using this tool had the cap running. This is the ' +
      'only number that claims protection.',
    example: 12,
  })
  armed: number;

  @ApiProperty({
    description: 'Teammates with at least one machine proven NOT to be running the cap.',
    example: 1,
  })
  notArmed: number;

  @ApiProperty({
    description:
      'Teammates whose cap state is unknown: a meter too old to answer for this tool, or a check ' +
      'that did not answer. Never counted as armed.',
    example: 1,
  })
  unknown: number;

  @ApiProperty({
    description:
      'armed + notArmed + unknown. Distinct teammates who used this tool in the window. ' +
      'The two tools count separately, so claudeCode.total + codex.total does not equal total.',
    example: 14,
  })
  total: number;
}

export class CoverageResponseDto {
  @ApiProperty({
    description:
      'Pre-split blended count, kept for clients written before the per-tool split. Distinct ' +
      'teammates carrying the legacy controlArmed stamp on any internal event in the window. ' +
      'In practice this is Claude-hook presence. Superseded by claudeCode and codex.',
    example: 13,
  })
  armed: number;

  @ApiProperty({
    description:
      'Pre-split blended count: distinct teammates with any internal coding-agent event in ' +
      'the window, across both tools.',
    example: 15,
  })
  total: number;

  @ApiProperty({
    description:
      'Newest event time in the window, ISO. Null when there is no recent activity (honest ' +
      'absence, never a fabricated time).',
    example: '2026-07-22T12:00:00.000Z',
    nullable: true,
    type: String,
  })
  asOf: string | null;

  @ApiProperty({ type: ToolCoverageDto })
  claudeCode: ToolCoverageDto;

  @ApiProperty({ type: ToolCoverageDto })
  codex: ToolCoverageDto;
}
