import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentProvidersController } from './payment-providers.controller';
import { PaymentProvidersService } from './payment-providers.service';
import { PaymentProcessingService } from './payment-processing.service';
import { PaymentAdapterFactory } from './payment-adapter.factory';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [PaymentProvidersController],
  providers: [PaymentProvidersService, PaymentProcessingService, PaymentAdapterFactory],
  exports: [PaymentProvidersService, PaymentProcessingService, PaymentAdapterFactory],
})
export class PaymentProvidersModule {}
