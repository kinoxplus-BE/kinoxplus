import { Injectable, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack web billing. TODO(sprint-6): initializeTransaction via
 * POST https://api.paystack.co/transaction/initialize — never trust the
 * client redirect, entitlement flows through the webhook.
 */
@Injectable()
export class PaystackProvider {
  constructor(private readonly config: ConfigService) {}

  initializeTransaction(_userId: string, _planId: string): Promise<never> {
    throw new NotImplementedException(
      'paystack.initializeTransaction — sprint 6',
    );
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
