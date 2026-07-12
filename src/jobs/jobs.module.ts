import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CleanupProcessor } from './processors/cleanup.processor';
import { PaymentsProcessor } from './processors/payments.processor';
import { QUEUES } from './queues';

/** Registers every queue; producers import this module to @InjectQueue. */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.EMAILS },
      { name: QUEUES.PAYMENTS },
      { name: QUEUES.STREAMING },
      { name: QUEUES.NOTIFICATIONS },
      { name: QUEUES.CLEANUP },
    ),
  ],
  providers: [PaymentsProcessor, CleanupProcessor],
  exports: [BullModule],
})
export class JobsModule {}
