import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { QUEUES } from '../../jobs/queues';

export type MailJobData =
  | { kind: 'welcome'; to: string; displayName: string }
  | {
      kind: 'otp';
      to: string;
      code: string;
      purpose: 'verify' | 'reset' | 'login';
    }
  | { kind: 'password-changed'; to: string };

/**
 * Producer for the emails queue. Auth flows enqueue here instead of calling
 * Brevo inline, so endpoint latency never depends on the mail provider and
 * transient failures retry with backoff instead of 500ing the request.
 */
@Injectable()
export class MailQueue {
  private static readonly JOB_OPTS: JobsOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  };

  constructor(
    @InjectQueue(QUEUES.EMAILS) private readonly queue: Queue<MailJobData>,
  ) {}

  async queueWelcome(to: string, displayName: string): Promise<void> {
    await this.add({ kind: 'welcome', to, displayName });
  }

  async queueOtp(
    to: string,
    code: string,
    purpose: 'verify' | 'reset' | 'login',
  ): Promise<void> {
    await this.add({ kind: 'otp', to, code, purpose });
  }

  async queuePasswordChanged(to: string): Promise<void> {
    await this.add({ kind: 'password-changed', to });
  }

  private async add(data: MailJobData): Promise<void> {
    await this.queue.add(data.kind, data, MailQueue.JOB_OPTS);
  }
}
