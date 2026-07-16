import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUES } from '../queues';

export const AUTH_CLEANUP_JOB = 'auth-cleanup';

// Revoked refresh tokens are kept 30 days after expiry so token-reuse
// detection still has history to match against before rows disappear.
const REFRESH_TOKEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OTP_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Periodic hygiene. Auth tables would otherwise grow without bound: every
 * login/refresh inserts a RefreshToken row and every OTP request inserts an
 * OtpChallenge row, and nothing deletes them.
 *
 * TODO(sprint-7): close stale rooms (no heartbeat).
 */
@Processor(QUEUES.CLEANUP)
export class CleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(CleanupProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === AUTH_CLEANUP_JOB) {
      await this.cleanAuthTables();
      return;
    }
    this.logger.log(`cleanup job ${job.name} (${job.id}) — no handler yet`);
  }

  private async cleanAuthTables(): Promise<void> {
    const now = Date.now();

    const tokens = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date(now - REFRESH_TOKEN_RETENTION_MS) } },
    });
    const otps = await this.prisma.otpChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(now - OTP_RETENTION_MS) } },
    });

    if (tokens.count > 0 || otps.count > 0) {
      this.logger.log(
        `auth cleanup: removed ${tokens.count} refresh tokens, ${otps.count} OTP challenges`,
      );
    }
  }
}
