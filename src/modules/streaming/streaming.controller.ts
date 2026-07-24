import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { Role, TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { VIDEO_PROVIDER, type VideoProvider } from './video-provider.interface';

@Controller('streaming')
export class StreamingController {
  constructor(
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider,
    private readonly prisma: PrismaService,
  ) {}

  /** Admin ingest: allocate a direct-creator upload for a title. */
  @Roles(Role.ADMIN)
  @Post('titles/:titleId/upload-url')
  async createUpload(@Param('titleId') titleId: string) {
    return this.video.createDirectUpload(titleId);
  }

  /** Signed playback URL — subscription-gated (never expose raw stream ids to guests). */
  @UseGuards(SubscriptionGuard)
  @Get('titles/:titleId/playback')
  async playback(@Param('titleId') titleId: string) {
    const title = await this.prisma.title.findUnique({
      where: { id: titleId },
      select: { streamVideoId: true, pocPlaybackUrl: true, status: true },
    });
    if (
      !title ||
      title.status !== TitleStatus.READY ||
      (!title.streamVideoId && !title.pocPlaybackUrl)
    ) {
      throw new NotFoundException({
        code: 'TITLE_NOT_PLAYABLE',
        message: 'Title not found or not ready for playback.',
      });
    }

    if (title.pocPlaybackUrl) {
      return { url: title.pocPlaybackUrl, provider: 'poc-hls' };
    }

    const streamVideoId = title.streamVideoId;
    if (!streamVideoId) {
      throw new NotFoundException({
        code: 'TITLE_NOT_PLAYABLE',
        message: 'Title not found or not ready for playback.',
      });
    }

    const url = await this.video.getSignedPlaybackUrl(streamVideoId);
    return { url, provider: 'cloudflare-stream' };
  }
}
