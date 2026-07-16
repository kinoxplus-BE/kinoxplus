import { InjectQueue, BullModule } from '@nestjs/bullmq';
import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  AUTH_CLEANUP_JOB,
  CleanupProcessor,
} from './processors/cleanup.processor';
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
export class JobsModule implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(QUEUES.CLEANUP) private readonly cleanupQueue: Queue,
  ) {}

  /** Repeatable schedules are upserts — safe to re-run on every boot. */
  async onApplicationBootstrap(): Promise<void> {
    await this.cleanupQueue.upsertJobScheduler(
      AUTH_CLEANUP_JOB,
      { every: 6 * 60 * 60 * 1000 }, // every 6 hours
      { name: AUTH_CLEANUP_JOB },
    );
  }
}
