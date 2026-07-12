import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { PaymentsModule } from '../modules/payments/payments.module';
import { LivekitWebhookController } from './livekit-webhook.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';
import { StreamWebhookController } from './stream-webhook.controller';

@Module({
  imports: [JobsModule, PaymentsModule],
  controllers: [
    PaymentsWebhookController,
    StreamWebhookController,
    LivekitWebhookController,
  ],
})
export class WebhooksModule {}
