import { Module } from '@nestjs/common';
import { TeamController, InvitationsController } from './team.controller';
import { TeamService } from './team.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [TeamController, InvitationsController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
