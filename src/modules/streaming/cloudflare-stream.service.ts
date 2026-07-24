import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';
import { TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { DirectUpload, VideoProvider } from './video-provider.interface';

type CloudflareApiError = {
  code?: number;
  message?: string;
};

type CloudflareApiResponse<T> = {
  success: boolean;
  result?: T;
  errors?: CloudflareApiError[];
  messages?: CloudflareApiError[];
};

type CloudflareDirectUploadResult = {
  uid?: string;
  uploadURL?: string;
};

type CloudflareTokenResult = {
  token?: string;
};

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_PLAYBACK_BASE_URL = 'https://videodelivery.net';
const DEFAULT_UPLOAD_EXPIRY_SEC = 60 * 60 * 2;
const DEFAULT_TOKEN_TTL_SEC = 60 * 60;
const MAX_STREAM_TOKEN_TTL_SEC = 60 * 60 * 24;

@Injectable()
export class CloudflareStreamService implements VideoProvider {
  private readonly logger = new Logger(CloudflareStreamService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    if (!this.config.get<string>('CF_STREAM_API_TOKEN')) {
      this.logger.warn(
        'CF_STREAM_API_TOKEN is not set; Stream direct upload and API-token playback fallback are disabled.',
      );
    }
    if (!this.hasLocalSigningConfig()) {
      this.logger.warn(
        'Cloudflare Stream signing key env vars are not complete; signed playback will fall back to the Cloudflare token API when possible.',
      );
    }
  }

  async createDirectUpload(titleId: string): Promise<DirectUpload> {
    const title = await this.prisma.title.findUnique({
      where: { id: titleId },
      select: { id: true, name: true, durationSec: true },
    });
    if (!title) {
      throw new NotFoundException({
        code: 'TITLE_NOT_FOUND',
        message: 'Title not found.',
      });
    }

    const accountId = this.getRequiredConfig('CF_ACCOUNT_ID');
    const uploadExpiry = new Date(
      Date.now() + DEFAULT_UPLOAD_EXPIRY_SEC * 1000,
    ).toISOString();
    const maxDurationSeconds = title.durationSec
      ? Math.min(Math.ceil(title.durationSec) + 300, 36_000)
      : -1;

    const result =
      await this.cloudflareRequest<CloudflareDirectUploadResult>(
        `/accounts/${accountId}/stream/direct_upload`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Upload-Creator': title.id,
          },
          body: JSON.stringify({
            maxDurationSeconds,
            creator: title.id,
            expiry: uploadExpiry,
            meta: { titleId: title.id, name: title.name },
            requireSignedURLs: true,
          }),
        },
      );

    if (!result.uid || !result.uploadURL) {
      throw new BadGatewayException({
        code: 'CLOUDFLARE_STREAM_BAD_RESPONSE',
        message: 'Cloudflare did not return a usable upload URL.',
      });
    }

    await this.prisma.title.update({
      where: { id: title.id },
      data: {
        streamVideoId: result.uid,
        pocPlaybackUrl: null,
        status: TitleStatus.PROCESSING,
      },
    });

    return { videoId: result.uid, uploadUrl: result.uploadURL };
  }

  async getSignedPlaybackUrl(videoId: string): Promise<string> {
    const token = this.hasLocalSigningConfig()
      ? this.createLocalSignedToken(videoId)
      : await this.createApiSignedToken(videoId);

    return `${this.getPlaybackBaseUrl()}/${token}/manifest/video.m3u8`;
  }

  private createLocalSignedToken(videoId: string): string {
    const keyId = this.getRequiredConfig('CF_STREAM_SIGNING_KEY_ID');
    const privateKey = this.getDecodedSigningPem();
    if (!privateKey) {
      throw new ServiceUnavailableException({
        code: 'CLOUDFLARE_STREAM_SIGNING_UNCONFIGURED',
        message: 'Cloudflare Stream signing key is not configured.',
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: keyId };
    const payload = {
      sub: videoId,
      kid: keyId,
      exp: now + this.getTokenTtlSec(),
      nbf: now - 10,
    };
    const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);

    return `${unsigned}.${base64Url(signature)}`;
  }

  private async createApiSignedToken(videoId: string): Promise<string> {
    const accountId = this.getRequiredConfig('CF_ACCOUNT_ID');
    const now = Math.floor(Date.now() / 1000);
    const result = await this.cloudflareRequest<CloudflareTokenResult>(
      `/accounts/${accountId}/stream/${videoId}/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exp: now + this.getTokenTtlSec(),
          nbf: now - 10,
        }),
      },
    );

    if (!result.token) {
      throw new BadGatewayException({
        code: 'CLOUDFLARE_STREAM_BAD_RESPONSE',
        message: 'Cloudflare did not return a signed playback token.',
      });
    }

    return result.token;
  }

  private async cloudflareRequest<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const apiToken = this.getRequiredConfig('CF_STREAM_API_TOKEN');
    const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });

    let body: CloudflareApiResponse<T> | null = null;
    try {
      body = (await response.json()) as CloudflareApiResponse<T>;
    } catch {
      body = null;
    }

    if (!response.ok || !body?.success || !body.result) {
      throw new BadGatewayException({
        code: 'CLOUDFLARE_STREAM_ERROR',
        message:
          getCloudflareMessage(body) ??
          `Cloudflare Stream request failed with status ${response.status}.`,
      });
    }

    return body.result;
  }

  private hasLocalSigningConfig(): boolean {
    return Boolean(
      this.config.get<string>('CF_STREAM_SIGNING_KEY_ID') &&
        this.config.get<string>('CF_STREAM_SIGNING_KEY_PEM'),
    );
  }

  private getDecodedSigningPem(): string | null {
    const raw = this.config.get<string>('CF_STREAM_SIGNING_KEY_PEM')?.trim();
    if (!raw) return null;

    const normalized = raw.replace(/\\n/g, '\n');
    if (normalized.includes('BEGIN')) {
      return normalized;
    }

    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
      return decoded.includes('BEGIN')
        ? decoded.replace(/\\n/g, '\n')
        : normalized;
    } catch {
      return normalized;
    }
  }

  private getPlaybackBaseUrl(): string {
    const configured =
      this.config.get<string>('CF_STREAM_PLAYBACK_BASE_URL') ??
      DEFAULT_PLAYBACK_BASE_URL;
    return configured.replace(/\/+$/, '');
  }

  private getTokenTtlSec(): number {
    const configured =
      this.config.get<number>('CF_STREAM_TOKEN_TTL_SEC') ??
      DEFAULT_TOKEN_TTL_SEC;
    return Math.min(configured, MAX_STREAM_TOKEN_TTL_SEC);
  }

  private getRequiredConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new ServiceUnavailableException({
        code: 'CLOUDFLARE_STREAM_UNCONFIGURED',
        message: `${key} is required for Cloudflare Stream.`,
      });
    }
    return value;
  }
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getCloudflareMessage<T>(
  response: CloudflareApiResponse<T> | null,
): string | null {
  const message =
    response?.errors?.find((error) => error.message)?.message ??
    response?.messages?.find((item) => item.message)?.message;
  return message ?? null;
}
