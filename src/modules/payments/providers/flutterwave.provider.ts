import { Injectable, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

/** Flutterwave web billing. TODO(sprint-6): standard checkout + verify. */
@Injectable()
export class FlutterwaveProvider {
  constructor(private readonly config: ConfigService) {}

  initializeTransaction(_userId: string, _planId: string): Promise<never> {
    throw new NotImplementedException(
      'flutterwave.initializeTransaction — sprint 6',
    );
  }

  /** Flutterwave sends the configured hash verbatim in `verif-hash`. */
  verifyWebhookSignature(signature: string | undefined): boolean {
    const expected = this.config.get<string>('FLUTTERWAVE_WEBHOOK_HASH');
    if (!expected || !signature) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
