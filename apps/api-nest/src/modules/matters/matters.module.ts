/**
 * WHAT THIS FILE DOES: Wires the matters REST module — the /v1
 * surface that mirrors the Law tab.
 *
 * CONNECTS TO: app.module.ts (imports this), matters.controller.ts,
 * matters.service.ts.
 */

import { Module } from '@nestjs/common';
import { MattersController } from './matters.controller';
import { MattersService } from './matters.service';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [MattersController],
  providers: [MattersService],
  exports: [MattersService],
})
export class MattersModule {}
