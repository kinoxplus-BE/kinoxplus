import { Injectable, Logger } from '@nestjs/common';
import { PayStatus, SubStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { CheckoutDto } from './dto/checkout.dto';
import { FlutterwaveProvider } from './providers/flutterwave.provider';
import { PaystackProvider } from './providers/paystack.provider';

/** Uniform return shape across providers so the mobile app has one contract. */
export interface CheckoutResult {
  provider: 'paystack' | 'flutterwave';
  authorizationUrl: string;
  reference: string;
}

/** Just the shape of a Paystack charge.success we actually rely on. */
interface PaystackChargeData {
  reference?: string;
  status?: string;
  amount?: number;
  currency?: string;
  metadata?: { planId?: string; userId?: string };
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackProvider,
    private readonly flutterwave: FlutterwaveProvider,
  ) {}

  /** Kicks off the provider checkout; entitlement is granted by the webhook, never here. */
  async checkout(userId: string, dto: CheckoutDto): Promise<CheckoutResult> {
    if (dto.provider === 'paystack') {
      const { authorizationUrl, reference } =
        await this.paystack.initializeTransaction(userId, dto.planId);
      return { provider: 'paystack', authorizationUrl, reference };
    }
    const { authorizationUrl, reference } =
      await this.flutterwave.initializeTransaction(userId, dto.planId);
    return { provider: 'flutterwave', authorizationUrl, reference };
  }

  /**
   * Handles a verified Paystack event. Today we only care about charge.success
   * — everything else is logged and ignored so failed deliveries don't block
   * unrelated retries. Idempotency: we check the Payment row's current status
   * before flipping it, so a duplicate delivery is a no-op instead of a
   * double-credit.
   */
  async handlePaystackEvent(body: {
    event?: string;
    data?: Record<string, unknown>;
  }): Promise<void> {
    if (body.event !== 'charge.success') {
      this.logger.log(`Paystack event ignored: ${body.event ?? 'unknown'}`);
      return;
    }
    const data = body.data as PaystackChargeData | undefined;
    const reference = data?.reference;
    if (!reference) {
      this.logger.warn('Paystack charge.success without reference — skipped');
      return;
    }

    const payment = await this.prisma.payment.findUnique({
      where: { providerRef: reference },
    });
    if (!payment) {
      // We didn't kick this off. Could be a manual charge from the dashboard
      // or a stale test event — log and move on rather than 500 on Paystack's
      // retry.
      this.logger.warn(`Paystack ref ${reference} has no matching Payment row`);
      return;
    }
    if (payment.status === PayStatus.SUCCESS) {
      // Duplicate delivery — already credited.
      return;
    }

    const planId = data?.metadata?.planId;
    const userId = data?.metadata?.userId;
    if (!planId || !userId) {
      this.logger.warn(
        `Paystack ref ${reference} missing metadata.planId/userId — payment recorded but not activated`,
      );
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PayStatus.SUCCESS, rawPayload: body as never },
      });
      return;
    }

    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: { intervalDays: true },
    });
    if (!plan) {
      this.logger.warn(
        `Paystack ref ${reference} references missing plan ${planId}`,
      );
      return;
    }

    const nextPeriodEnd = new Date(
      Date.now() + plan.intervalDays * 24 * 60 * 60 * 1000,
    );

    // Single transaction so a partial failure (payment marked SUCCESS but
    // subscription not extended) can't leave the user stuck.
    await this.prisma.$transaction(async (tx) => {
      const existingSub = await tx.subscription.findUnique({
        where: { userId },
        select: { currentPeriodEnd: true },
      });
      // If the sub is still active from a previous period, stack this cycle
      // on top; otherwise start a fresh window from now.
      const base =
        existingSub?.currentPeriodEnd &&
        existingSub.currentPeriodEnd > new Date()
          ? existingSub.currentPeriodEnd
          : new Date();
      const currentPeriodEnd = new Date(
        base.getTime() + plan.intervalDays * 24 * 60 * 60 * 1000,
      );

      const sub = await tx.subscription.upsert({
        where: { userId },
        create: {
          userId,
          planId,
          status: SubStatus.ACTIVE,
          provider: 'paystack',
          providerRef: reference,
          currentPeriodEnd: nextPeriodEnd,
        },
        update: {
          planId,
          status: SubStatus.ACTIVE,
          provider: 'paystack',
          providerRef: reference,
          currentPeriodEnd,
        },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PayStatus.SUCCESS,
          subscriptionId: sub.id,
          rawPayload: body as never,
        },
      });
    });

    this.logger.log(
      `Paystack ref ${reference} — subscription activated for ${userId}`,
    );
  }
}
