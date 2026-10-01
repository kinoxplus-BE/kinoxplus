import { Injectable } from '@nestjs/common';
import { Plan, PlanTier, SubStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** The effective entitlement envelope used for feature gates. Caller never
 *  gets back `null` — if the user has no active subscription, we return the
 *  FREE-tier plan as the baseline. */
export interface EffectivePlan {
  tier: PlanTier;
  maxRoomMembers: number;
  maxVideoHeight: number;
  maxSessionMinutes: number | null;
  canHDScreenShare: boolean;
  /** The underlying Plan row, if there is one. Null means caller is on the
   *  implicit baseline because no plan is configured as the free default. */
  plan: Plan | null;
}

/** Hard-coded baseline used only if the admin forgot to seed a FREE plan.
 *  Never trusted over a real FREE Plan row — those take precedence. */
const DEFAULT_FREE: Omit<EffectivePlan, 'plan'> = {
  tier: PlanTier.FREE,
  maxRoomMembers: 4,
  maxVideoHeight: 720,
  maxSessionMinutes: 60,
  canHDScreenShare: false,
};

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

  /**
   * Resolve the effective plan for a user. Returns the paid plan if the
   * subscription is ACTIVE and not expired; otherwise returns the FREE-tier
   * plan from the DB; otherwise a hard-coded baseline. Callers always get a
   * fully-populated entitlement envelope — never null — so feature gates
   * don't have to branch on absence.
   */
  async getEffectivePlan(userId: string): Promise<EffectivePlan> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId },
      include: { plan: true },
    });
    const subIsActive =
      sub &&
      sub.status === SubStatus.ACTIVE &&
      (sub.currentPeriodEnd === null || sub.currentPeriodEnd > new Date());
    if (subIsActive) {
      return {
        tier: sub.plan.tier,
        maxRoomMembers: sub.plan.maxRoomMembers,
        maxVideoHeight: sub.plan.maxVideoHeight,
        maxSessionMinutes: sub.plan.maxSessionMinutes,
        canHDScreenShare: sub.plan.canHDScreenShare,
        plan: sub.plan,
      };
    }

    // Fall back to the configured FREE plan (preferred — gives the admin
    // one place to tune baseline limits), then to a hard-coded safety net.
    // Deterministic order so that if someone seeds two FREE plans, every
    // request still resolves to the same one.
    const freePlan = await this.prisma.plan.findFirst({
      where: { tier: PlanTier.FREE, isActive: true },
      orderBy: { id: 'asc' },
    });
    if (freePlan) {
      return {
        tier: freePlan.tier,
        maxRoomMembers: freePlan.maxRoomMembers,
        maxVideoHeight: freePlan.maxVideoHeight,
        maxSessionMinutes: freePlan.maxSessionMinutes,
        canHDScreenShare: freePlan.canHDScreenShare,
        plan: freePlan,
      };
    }
    return { ...DEFAULT_FREE, plan: null };
  }
}
