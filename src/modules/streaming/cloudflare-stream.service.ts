import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DirectUpload, VideoProvider } from './video-provider.interface';

/**
 * TODO(sprint-3) — implement per AGENTS.md §8:
 * - createDirectUpload: POST /accounts/{CF_ACCOUNT_ID}/stream/direct_upload,
 *   store videoId on Title, set Title.status = PROCESSING
 * - ready webhook (webhooks/stream) flips status → READY
 * - getSignedPlaybackUrl: sign with CF_STREAM_SIGNING_KEY_ID/PEM, short expiry
 */
@Injectable()
export class CloudflareStreamService implements VideoProvider {
  private readonly logger = new Logger(CloudflareStreamService.name);

  constructor(private readonly config: ConfigService) {
    if (!config.get<string>('CF_STREAM_API_TOKEN')) {
      this.logger.warn(
        'Cloudflare Stream env vars not set — ingest/playback disabled.',
      );
    }
  }

  createDirectUpload(_titleId: string): Promise<DirectUpload> {
    throw new NotImplementedException(
      'streaming.createDirectUpload — sprint 3',
    );
  }

  getSignedPlaybackUrl(_videoId: string): Promise<string> {
    throw new NotImplementedException(
      'streaming.getSignedPlaybackUrl — sprint 3',
    );
  }
}
