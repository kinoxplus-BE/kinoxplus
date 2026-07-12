import { Injectable } from '@nestjs/common';
import { SubStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Entitlement check used by SubscriptionGuard before issuing playback URLs. */
  async isActive(userId: string): Promise<boolean> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      select: { status: true, currentPeriodEnd: true },
    });
    if (!sub || sub.status !== SubStatus.ACTIVE) return false;
    return sub.currentPeriodEnd === null || sub.currentPeriodEnd > new Date();
  }

  me(userId: string) {
    return this.prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });
  }

  listPlans() {
    return this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { priceKobo: 'asc' },
    });
  }
}
