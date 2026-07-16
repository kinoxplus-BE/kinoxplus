import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QUEUES } from '../../jobs/queues';
import type { MailJobData } from './mail.queue';
import { MailService } from './mail.service';

/** Consumes the emails queue and dispatches to the Brevo-backed MailService. */
@Processor(QUEUES.EMAILS)
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private readonly mail: MailService) {
    super();
  }

  async process(job: Job<MailJobData>): Promise<void> {
    const data = job.data;
    switch (data.kind) {
      case 'welcome':
        await this.mail.sendWelcome(data.to, data.displayName);
        break;
      case 'otp':
        switch (data.purpose) {
          case 'verify':
            await this.mail.sendVerificationOtp(data.to, data.code);
            break;
          case 'reset':
            await this.mail.sendPasswordResetOtp(data.to, data.code);
            break;
          case 'login':
            await this.mail.sendLoginOtp(data.to, data.code);
            break;
        }
        break;
      case 'password-changed':
        await this.mail.sendPasswordChanged(data.to);
        break;
      default:
        this.logger.warn(`Unknown mail job: ${job.name}`);
    }
  }
}
