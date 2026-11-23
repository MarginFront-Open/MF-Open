import { Module } from '@nestjs/common';
import { StripeConnectController } from './stripe-connect.controller';
import { StripeConnectService } from './stripe-connect.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
// Stripe-connect mirrors the OAuth account into a payment_providers row
// so the rest of the checkout pipeline can find it. That mirroring lives in
// PaymentProvidersService.upsertStripeConnectProvider — imported here to make the service
// available to StripeConnectService.
import { PaymentProvidersModule } from '../payment-providers/payment-providers.module';

@Module({
  imports: [PrismaModule, PaymentProvidersModule],
  controllers: [StripeConnectController],
  providers: [StripeConnectService],
  exports: [StripeConnectService],
})
export class StripeConnectModule {}
