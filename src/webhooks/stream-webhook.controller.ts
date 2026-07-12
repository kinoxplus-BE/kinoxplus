import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { TitleStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface StreamWebhookBody {
  uid?: string;
  status?: { state?: string };
  readyToStream?: boolean;
}

/**
 * Cloudflare Stream calls back when encoding finishes → flip Title to READY.
 * TODO(sprint-3): verify the Webhook-Signature header (HMAC on raw body)
 * once the Stream webhook secret is configured.
 */
@Public()
@Controller('webhooks')
export class StreamWebhookController {
  private readonly logger = new Logger(StreamWebhookController.name);

  constructor(private readonly prisma: PrismaService) {}

  @HttpCode(200)
  @Post('stream')
  async stream(@Body() body: StreamWebhookBody) {
    if (!body.uid) {
      throw new BadRequestException({
        code: 'WEBHOOK_MALFORMED',
        message: 'Missing video uid.',
      });
    }

    const ready = body.readyToStream === true || body.status?.state === 'ready';
    if (!ready) return { received: true };

    const updated = await this.prisma.title.updateMany({
      where: { streamVideoId: body.uid, status: TitleStatus.PROCESSING },
      data: { status: TitleStatus.READY },
    });
    if (updated.count > 0) {
      this.logger.log(`Title with stream video ${body.uid} is READY`);
    }
    return { received: true };
  }
}
