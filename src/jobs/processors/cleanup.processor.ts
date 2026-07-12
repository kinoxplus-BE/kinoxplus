import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../queues';

/**
 * Cron-style hygiene: TODO(sprint-7) — expire OtpChallenges, close stale
 * rooms (no heartbeat), prune revoked/expired RefreshTokens.
 */
@Processor(QUEUES.CLEANUP)
export class CleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(CleanupProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(
      `cleanup job ${job.name} (${job.id}) received — handler pending sprint 7`,
    );
    await Promise.resolve();
  }
}
