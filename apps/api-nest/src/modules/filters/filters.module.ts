import { Module } from '@nestjs/common';
import { FiltersController } from './filters.controller';
import { FiltersService } from './filters.service';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [FiltersController],
  providers: [FiltersService],
  exports: [FiltersService],
})
export class FiltersModule {}
