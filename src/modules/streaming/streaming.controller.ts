import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { ApiEnvelope } from '../../common/swagger/api-envelope.decorator';
import { Role, TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectUploadDto, PlaybackUrlDto } from './dto/streaming-responses.dto';
import { VIDEO_PROVIDER, type VideoProvider } from './video-provider.interface';

@ApiTags('Streaming')
@Controller('streaming')
export class StreamingController {
  constructor(
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider,
    private readonly prisma: PrismaService,
  ) {}

  /** Admin ingest: allocate a direct-creator upload for a title. */
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create an admin upload URL for a title',
    description:
      'Cloudflare Stream ingest path for licensed content. POC TMDB titles do not use this.',
  })
  @ApiEnvelope(DirectUploadDto, { description: 'Direct upload allocation' })
  @Roles(Role.ADMIN)
  @Header('Cache-Control', 'no-store')
  @Post('titles/:titleId/upload-url')
  async createUpload(@Param('titleId') titleId: string) {
    return this.video.createDirectUpload(titleId);
  }

  /** Signed playback URL — subscription-gated (never expose raw stream ids to guests). */
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get a playable URL for a title',
    description:
      'Subscription-gated playback endpoint. POC titles return provider=poc-hls with a public demo stream; real titles return provider=cloudflare-stream with a signed URL.',
  })
  @ApiEnvelope(PlaybackUrlDto, { description: 'Playable title URL' })
  @UseGuards(SubscriptionGuard)
  @Header('Cache-Control', 'private, max-age=30')
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
