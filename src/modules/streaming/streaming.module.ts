import { Module } from '@nestjs/common';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CloudflareStreamService } from './cloudflare-stream.service';
import { StreamingController } from './streaming.controller';
import { StreamingService } from './streaming.service';
import { VIDEO_PROVIDER } from './video-provider.interface';

@Module({
  imports: [SubscriptionsModule],
  controllers: [StreamingController],
  providers: [
    SubscriptionGuard,
    StreamingService,
    // DRM required? Swap this binding to a MuxService — the seam is the point.
    { provide: VIDEO_PROVIDER, useClass: CloudflareStreamService },
  ],
  exports: [VIDEO_PROVIDER, StreamingService],
})
export class StreamingModule {}
