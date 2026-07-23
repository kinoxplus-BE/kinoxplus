import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active sessions for a user — every non-revoked, non-expired refresh
   * token, most-recently-used first. Each row is what the Netflix
   * "Manage devices" screen renders.
   */
  list(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        deviceName: true,
        deviceModel: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        lastUsedAt: true,
        lastUsedIp: true,
        createdAt: true,
        expiresAt: true,
      },
    });
  }

  /**
   * Revoke a single session by id. Scoped by userId so one user can't
   * revoke another user's session even if they guess the id.
   */
  async revoke(userId: string, sessionId: string) {
    const result = await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found or already revoked.',
      });
    }
    return { message: 'Session revoked.' };
  }
}
