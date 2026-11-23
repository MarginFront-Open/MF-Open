import { Module } from '@nestjs/common';
import { InvoiceCalculatorController } from './invoice-calculator.controller';
import { InvoiceCalculatorService } from './invoice-calculator.service';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [InvoiceCalculatorController],
  providers: [InvoiceCalculatorService],
  exports: [InvoiceCalculatorService],
})
export class InvoiceCalculatorModule {}
