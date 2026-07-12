import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent on fcmToken — a token can migrate between users/devices. */
  registerDevice(userId: string, fcmToken: string, platform: string) {
    return this.prisma.device.upsert({
      where: { fcmToken },
      create: { userId, fcmToken, platform },
      update: { userId, platform },
    });
  }

  /**
   * TODO(sprint-7): FCM fan-out via the notifications queue (firebase-admin,
   * creds from FCM_* env vars). In-app notifications ride Socket.io.
   */
  async sendToUser(userId: string, title: string, body: string): Promise<void> {
    this.logger.log(`push to ${userId} pending sprint 7: ${title} — ${body}`);
    await Promise.resolve();
  }
}
