import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { PrismaService } from '../../prisma/prisma.service';

/** Data payload attached to a push — must be flat string map per FCM. */
export type PushData = Record<string, string>;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private messaging?: Messaging;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const projectId = this.config.get<string>('FCM_PROJECT_ID');
    const clientEmail = this.config.get<string>('FCM_CLIENT_EMAIL');
    // Render stores multi-line values escaped as \n; unescape them here.
    const privateKey = this.config
      .get<string>('FCM_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'FCM env vars not set — push notifications will log only.',
      );
      return;
    }

    if (getApps().length === 0) {
      initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
      });
    }
    this.messaging = getMessaging();
  }

  /** Idempotent on fcmToken — a token can migrate between users/devices. */
  registerDevice(userId: string, fcmToken: string, platform: string) {
    return this.prisma.device.upsert({
      where: { fcmToken },
      create: { userId, fcmToken, platform },
      update: { userId, platform },
    });
  }

  /**
   * Fan out a push to every device this user has registered. Data payload
   * lets the mobile app deep-link (e.g. `{ kind: "room_invite", roomId, code }`).
   * Failures are logged but never thrown — never fail the caller's request
   * because a device happens to be offline.
   */
  async sendToUser(
    userId: string,
    notification: { title: string; body: string },
    data: PushData = {},
  ): Promise<void> {
    if (!this.messaging) {
      this.logger.log(
        `[DEV] push to ${userId}: ${notification.title} — ${notification.body}`,
      );
      return;
    }

    const devices = await this.prisma.device.findMany({
      where: { userId },
      select: { fcmToken: true },
    });
    if (devices.length === 0) return;

    const tokens = devices.map((d) => d.fcmToken);
    const response = await this.messaging.sendEachForMulticast({
      tokens,
      notification,
      data,
    });

    // Prune tokens FCM tells us are permanently invalid (uninstalled app,
    // token rotated). Non-permanent errors (network, throttled) left alone.
    const staleTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (
        !r.success &&
        r.error &&
        (r.error.code === 'messaging/registration-token-not-registered' ||
          r.error.code === 'messaging/invalid-registration-token')
      ) {
        staleTokens.push(tokens[i]);
      }
    });
    if (staleTokens.length > 0) {
      await this.prisma.device.deleteMany({
        where: { fcmToken: { in: staleTokens } },
      });
    }

    if (response.failureCount > 0) {
      this.logger.warn(
        `Push to ${userId}: ${response.successCount} ok, ${response.failureCount} failed`,
      );
    }
  }
}
