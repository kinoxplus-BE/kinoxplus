import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Paystack web billing.
 *
 * We initialize a transaction on Paystack, persist a PENDING Payment row keyed
 * by our own reference, and hand the client the hosted `authorization_url`. The
 * source of truth for granting entitlement is the webhook (see PaymentsController)
 * — never the client's redirect back to us. That's the standard Paystack
 * pattern and it's what stops a lost redirect from silently under-charging or
 * over-crediting a subscriber.
 */
@Injectable()
export class PaystackProvider {
  private readonly logger = new Logger(PaystackProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async initializeTransaction(
    userId: string,
    planId: string,
  ): Promise<{ authorizationUrl: string; reference: string }> {
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secret) {
      throw new ServiceUnavailableException({
        code: 'PAYSTACK_NOT_CONFIGURED',
        message: 'Paystack is not configured on this environment.',
      });
    }

    const [user, plan] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      }),
      this.prisma.plan.findUnique({
        where: { id: planId },
        select: {
          id: true,
          isActive: true,
          priceKobo: true,
          currency: true,
        },
      }),
    ]);
    if (!user?.email) {
      throw new BadRequestException({
        code: 'EMAIL_REQUIRED',
        message: 'An email is required before starting a Paystack checkout.',
      });
    }
    if (!plan || !plan.isActive) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'Plan not found or inactive.',
      });
    }

    // Reference format: kx_<16 hex>. Deterministic prefix helps humans reading
    // the Paystack dashboard identify our transactions; the random tail keeps
    // it globally unique. We store this on the Payment row and it's what the
    // webhook uses to look the row up.
    const reference = `kx_${randomBytes(8).toString('hex')}`;

    const callbackBase = this.config.get<string>('PAYSTACK_CALLBACK_URL');

    let response: Response;
    try {
      response = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: user.email,
          amount: plan.priceKobo,
          currency: plan.currency,
          reference,
          ...(callbackBase ? { callback_url: callbackBase } : {}),
          metadata: { userId, planId },
        }),
      });
    } catch (err) {
      this.logger.error(
        `Paystack initialize network error: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
      throw new ServiceUnavailableException({
        code: 'PAYSTACK_UNREACHABLE',
        message: 'Could not reach the payment provider. Please try again.',
      });
    }

    const raw = (await response.json()) as {
      status?: boolean;
      message?: string;
      data?: { authorization_url?: string; reference?: string };
    };
    if (!response.ok || !raw.status || !raw.data?.authorization_url) {
      this.logger.warn(
        `Paystack initialize failed: ${response.status} — ${
          raw.message ?? 'no message'
        }`,
      );
      throw new ServiceUnavailableException({
        code: 'PAYSTACK_INIT_FAILED',
        message: raw.message ?? 'Could not start payment.',
      });
    }

    // Persist BEFORE returning to the client — the webhook needs a row to
    // flip to SUCCESS. Idempotent by (providerRef) uniqueness on Payment.
    await this.prisma.payment.create({
      data: {
        provider: 'paystack',
        providerRef: reference,
        amountKobo: plan.priceKobo,
        currency: plan.currency,
        status: 'PENDING',
        rawPayload: { init: raw.data, planId, userId },
      },
    });

    return {
      authorizationUrl: raw.data.authorization_url,
      reference,
    };
  }

  /** HMAC-SHA512 of the raw body with the secret key. */
  verifyWebhookSignature(
    rawBody: Buffer,
    signature: string | undefined,
  ): boolean {
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secret || !signature) return false;
    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
