import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../queues';

/**
 * Post-webhook processing so webhook controllers return 200 fast:
 * TODO(sprint-6) — verify with provider API, upsert Payment (idempotent on
 * providerRef), flip Subscription → ACTIVE, set currentPeriodEnd, queue receipt email.
 */
@Processor(QUEUES.PAYMENTS)
export class PaymentsProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentsProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(
      `payments job ${job.name} (${job.id}) received — handler pending sprint 6`,
    );
    await Promise.resolve();
  }
}
