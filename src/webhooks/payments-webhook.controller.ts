import { InjectQueue } from '@nestjs/bullmq';
import {
  Controller,
  Headers,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { QUEUES } from '../jobs/queues';
import { FlutterwaveProvider } from '../modules/payments/providers/flutterwave.provider';
import { PaystackProvider } from '../modules/payments/providers/paystack.provider';

/**
 * Payment webhooks: verify signature on the RAW body, enqueue, return 200
 * fast. Processing (idempotent on providerRef — webhooks re-fire) happens in
 * the payments queue (AGENTS.md §9).
 */
@Public()
@Controller('webhooks')
export class PaymentsWebhookController {
  constructor(
    @InjectQueue(QUEUES.PAYMENTS) private readonly paymentsQueue: Queue,
    private readonly paystack: PaystackProvider,
    private readonly flutterwave: FlutterwaveProvider,
  ) {}

  @HttpCode(200)
  @Post('paystack')
  async handlePaystack(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature?: string,
  ) {
    if (
      !req.rawBody ||
      !this.paystack.verifyWebhookSignature(req.rawBody, signature)
    ) {
      throw new UnauthorizedException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid webhook signature.',
      });
    }
    await this.paymentsQueue.add(
      'paystack-event',
      JSON.parse(req.rawBody.toString('utf8')),
    );
    return { received: true };
  }

  @HttpCode(200)
  @Post('flutterwave')
  async handleFlutterwave(
    @Req() req: RawBodyRequest<Request>,
    @Headers('verif-hash') signature?: string,
  ) {
    if (!req.rawBody || !this.flutterwave.verifyWebhookSignature(signature)) {
      throw new UnauthorizedException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Invalid webhook signature.',
      });
    }
    await this.paymentsQueue.add(
      'flutterwave-event',
      JSON.parse(req.rawBody.toString('utf8')),
    );
    return { received: true };
  }
}
