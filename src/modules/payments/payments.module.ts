import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { FlutterwaveProvider } from './providers/flutterwave.provider';
import { PaystackProvider } from './providers/paystack.provider';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaystackProvider, FlutterwaveProvider],
  exports: [PaymentsService, PaystackProvider, FlutterwaveProvider],
})
export class PaymentsModule {}
