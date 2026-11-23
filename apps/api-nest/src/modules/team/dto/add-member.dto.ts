import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsEnum } from 'class-validator';
import { TeamRole } from './update-member-role.dto';

export class AddMemberDto {
  @ApiProperty({ description: 'User ID to add as team member' })
  @IsUUID()
  userId: string;

  @ApiProperty({ description: 'Role for the new member', enum: TeamRole })
  @IsEnum(TeamRole)
  role: TeamRole;
}
