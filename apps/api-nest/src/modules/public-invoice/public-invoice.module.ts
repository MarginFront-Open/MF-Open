import { Module } from '@nestjs/common';
import { PublicInvoiceController } from './public-invoice.controller';
import { PublicInvoiceService } from './public-invoice.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';

/**
 * Public Invoice Module
 *
 * Provides public access to invoice information and payment capabilities.
 * All endpoints are unauthenticated and accessible via invoice ID.
 *
 * Payment processing is delegated to PaymentProvidersModule.
 */
@Module({
  imports: [PrismaModule, PaymentProvidersModule],
  controllers: [PublicInvoiceController],
  providers: [PublicInvoiceService],
  exports: [PublicInvoiceService],
})
export class PublicInvoiceModule {}
