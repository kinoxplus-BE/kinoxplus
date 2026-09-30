import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthUser } from '../../common/types';
import { CheckoutDto } from './dto/checkout.dto';
import { PaymentsService } from './payments.service';
import { PaystackProvider } from './providers/paystack.provider';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly paystack: PaystackProvider,
  ) {}

  @Post('checkout')
  @ApiOperation({
    summary: 'Start a hosted checkout',
    description:
      'Returns { authorizationUrl, reference }. Redirect the user to the URL; entitlement is granted by the webhook after the user completes payment on the provider page.',
  })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutDto) {
    return this.payments.checkout(user.id, dto);
  }

  /**
   * Paystack posts events here after a successful charge. The endpoint must
   * be publicly reachable and idempotent — Paystack retries failed webhook
   * deliveries and we've seen the same event arrive twice within seconds.
   *
   * Signature is verified against the raw body, which is why main.ts passes
   * `rawBody: true` to NestFactory.create. Without that, req.rawBody would be
   * undefined and every request would 401.
   */
  @Public()
  @Post('webhooks/paystack')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Paystack event webhook',
    description:
      'Verifies signature and processes charge.success events. Idempotent by reference.',
  })
  async paystackWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string | undefined,
    @Body() body: { event?: string; data?: Record<string, unknown> },
  ) {
    if (!req.rawBody) {
      // Guardrail: the app boots with rawBody: true — if this is ever
      // missing, refuse rather than trust the parsed body for HMAC.
      throw new BadRequestException({
        code: 'RAW_BODY_MISSING',
        message: 'Raw body is required for webhook verification.',
      });
    }
    if (!this.paystack.verifyWebhookSignature(req.rawBody, signature)) {
      throw new UnauthorizedException({
        code: 'INVALID_SIGNATURE',
        message: 'Webhook signature did not match.',
      });
    }
    await this.payments.handlePaystackEvent(body);
    return { received: true };
  }
}
