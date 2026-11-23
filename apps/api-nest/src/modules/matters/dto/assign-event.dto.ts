/**
 * WHAT THIS FILE DOES: Request DTO for POST /v1/matters/assign —
 * the manual assignment/unassignment of one usage event, mirroring the
 * dashboard's assignEventToMatter.
 *
 * CONNECTS TO: matters.controller.ts, matters.service.ts,
 * apps/dashboard/app/actions/matters.ts (assignEventToMatter).
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, ValidateIf } from 'class-validator';

export class AssignEventDto {
  @ApiProperty({ description: 'The usage event to move (UUID)' })
  @IsUUID()
  eventId: string;

  @ApiProperty({
    description:
      'Target matter UUID, or null to unassign. Either way the event is stamped ' +
      "source 'manual', which outranks tag and rule attribution. An unassigned " +
      'event with a manual stamp is never re-swept by apply-rules.',
    nullable: true,
  })
  @ValidateIf((dto: AssignEventDto) => dto.matterId !== null)
  @IsUUID()
  matterId: string | null;
}
