import { Inject, Injectable, Logger } from '@nestjs/common';
import { TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { VIDEO_PROVIDER, type VideoProvider } from './video-provider.interface';

export type ResolvedPlayback = {
  url: string;
  provider: 'poc-hls' | 'cloudflare-stream';
};

/**
 * Playback URL resolver — the one place that turns a titleId into a
 * playable URL. Shared by the /streaming/titles/:id/playback REST endpoint
 * AND the Watch Rooms gateway (so `room:join` and `title:changed` can
 * ship the URL inline and save the client an extra round trip).
 *
 * POC titles return their static HLS URL; real titles get a signed
 * Cloudflare Stream URL (Redis-cached in CloudflareStreamService).
 */
@Injectable()
export class StreamingService {
  private readonly logger = new Logger(StreamingService.name);

  constructor(
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider,
    private readonly prisma: PrismaService,
  ) {}

  async resolvePlayback(titleId: string): Promise<ResolvedPlayback | null> {
    const title = await this.prisma.title.findUnique({
      where: { id: titleId },
      select: { streamVideoId: true, pocPlaybackUrl: true, status: true },
    });
    if (
      !title ||
      title.status !== TitleStatus.READY ||
      (!title.streamVideoId && !title.pocPlaybackUrl)
    ) {
      return null;
    }
    if (title.pocPlaybackUrl) {
      return { url: title.pocPlaybackUrl, provider: 'poc-hls' };
    }
    const url = await this.video.getSignedPlaybackUrl(title.streamVideoId!);
    return { url, provider: 'cloudflare-stream' };
  }

  /**
   * Same as resolvePlayback but swallows and logs failures — used by the
   * Watch Rooms gateway to enrich room events. A Cloudflare hiccup
   * shouldn't make a room:join fail; frontend can fall back to the
   * `GET /streaming/titles/:id/playback` REST call.
   */
  async safeResolvePlayback(titleId: string): Promise<ResolvedPlayback | null> {
    try {
      return await this.resolvePlayback(titleId);
    } catch (error) {
      this.logger.warn(
        `Playback resolve failed for ${titleId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return null;
    }
  }
}
