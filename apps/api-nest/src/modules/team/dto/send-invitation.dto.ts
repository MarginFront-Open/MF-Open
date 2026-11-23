import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum } from 'class-validator';
import { TeamRole } from './update-member-role.dto';

export class SendInvitationDto {
  @ApiProperty({ description: 'Email address to send invitation' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Role for the invited member', enum: TeamRole })
  @IsEnum(TeamRole)
  role: TeamRole;
}
