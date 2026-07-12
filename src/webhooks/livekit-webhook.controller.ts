import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { Public } from '../common/decorators/public.decorator';

/**
 * LiveKit webhooks (participant_joined/left, room_finished) — used to
 * reconcile voice presence. TODO(sprint-5): reconcile RoomMember rows.
 */
@Public()
@Controller('webhooks')
export class LivekitWebhookController {
  private readonly logger = new Logger(LivekitWebhookController.name);
  private readonly receiver?: WebhookReceiver;

  constructor(config: ConfigService) {
    const key = config.get<string>('LIVEKIT_API_KEY');
    const secret = config.get<string>('LIVEKIT_API_SECRET');
    if (key && secret) {
      this.receiver = new WebhookReceiver(key, secret);
    }
  }

  @HttpCode(200)
  @Post('livekit')
  async livekit(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization?: string,
  ) {
    if (!this.receiver || !req.rawBody) {
      throw new UnauthorizedException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'LiveKit webhooks are not configured.',
      });
    }
    // Verifies the JWT in the Authorization header against the raw body.
    const event = await this.receiver.receive(
      req.rawBody.toString('utf8'),
      authorization,
    );
    this.logger.log(`LiveKit event: ${event.event}`);
    return { received: true };
  }
}
