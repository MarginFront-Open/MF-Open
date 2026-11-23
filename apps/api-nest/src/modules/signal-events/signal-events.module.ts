import { Module } from '@nestjs/common';
import { SignalEventsController } from './signal-events.controller';
import { SignalEventsService } from './signal-events.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { EventProcessingModule } from '../event-processing/event-processing.module';

@Module({
  imports: [PrismaModule, EventProcessingModule],
  controllers: [SignalEventsController],
  providers: [SignalEventsService],
  exports: [SignalEventsService],
})
export class SignalEventsModule {}
