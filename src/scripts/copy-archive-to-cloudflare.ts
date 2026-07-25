import 'dotenv/config';
import Redis from 'ioredis';
import { PrismaClient, TitleStatus } from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma/prisma-pg-adapter';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

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

type CloudflareStreamStatus = {
  state?: string;
  errorReasonCode?: string;
  errorReasonText?: string;
};

type CloudflareStreamVideo = {
  uid?: string;
  readyToStream?: boolean;
  status?: CloudflareStreamStatus;
  meta?: Record<string, string>;
  playback?: {
    hls?: string;
    dash?: string;
  };
};

type ArchiveTitle = {
  id: string;
  name: string;
  slug: string;
  pocPlaybackUrl: string | null;
  streamVideoId: string | null;
  licenseSource: string | null;
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const accountId = process.env.CF_ACCOUNT_ID;
if (!accountId) {
  throw new Error('CF_ACCOUNT_ID is required.');
}

const apiToken = process.env.CF_STREAM_API_TOKEN;
if (!apiToken) {
  throw new Error('CF_STREAM_API_TOKEN is required.');
}

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(databaseUrl),
});

async function main(): Promise<void> {
  const shouldWait = parseBoolean(process.env.CF_STREAM_COPY_WAIT);
  const limit = parsePositiveInt(process.env.CF_STREAM_COPY_LIMIT);
  const titles = await loadArchiveTitles(limit);

  if (titles.length === 0) {
    console.log('No Internet Archive titles need Cloudflare Stream sync.');
    return;
  }

  console.log(
    `Syncing ${titles.length} Internet Archive title(s) to Cloudflare Stream...`,
  );

  for (const title of titles) {
    await syncTitle(title);
  }

  if (shouldWait) {
    await waitForReady(titles.map((title) => title.id));
  }

  await clearCatalogCache();
  console.log('Cloudflare Stream sync complete.');
}

async function loadArchiveTitles(
  limit: number | null,
): Promise<ArchiveTitle[]> {
  return prisma.title.findMany({
    where: {
      status: TitleStatus.READY,
      licenseSource: {
        startsWith: 'Internet Archive curated seed:',
      },
      OR: [{ pocPlaybackUrl: { not: null } }, { streamVideoId: { not: null } }],
    },
    orderBy: { createdAt: 'asc' },
    take: limit ?? undefined,
    select: {
      id: true,
      name: true,
      slug: true,
      pocPlaybackUrl: true,
      streamVideoId: true,
      licenseSource: true,
    },
  });
}

async function syncTitle(title: ArchiveTitle): Promise<void> {
  if (title.streamVideoId) {
    await syncExistingVideo(title);
    return;
  }

  if (!title.pocPlaybackUrl) {
    console.warn(`Skipped ${title.name}: no Archive playback URL found.`);
    return;
  }

  const video = await cloudflareRequest<CloudflareStreamVideo>(
    `/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: title.pocPlaybackUrl,
        meta: {
          name: title.name,
          titleId: title.id,
          slug: title.slug,
          source: 'internet-archive',
        },
        requireSignedURLs: true,
      }),
    },
  );

  if (!video.uid) {
    throw new Error(`Cloudflare did not return a uid for ${title.name}.`);
  }

  await prisma.title.update({
    where: { id: title.id },
    data: {
      streamVideoId: video.uid,
      licenseSource: appendCloudflareNote(title.licenseSource, video.uid),
    },
  });

  console.log(
    `Queued ${title.name} -> Cloudflare ${video.uid} (${video.status?.state ?? 'queued'})`,
  );

  if (video.readyToStream) {
    await markCloudflareReady(title.id, title.name, video.uid);
  }
}

async function syncExistingVideo(title: ArchiveTitle): Promise<void> {
  const videoId = title.streamVideoId;
  if (!videoId) {
    console.warn(`Skipped ${title.name}: no Cloudflare video id found.`);
    return;
  }

  const video = await fetchCloudflareVideo(videoId);
  const state = video.status?.state ?? 'unknown';

  if (video.readyToStream) {
    await markCloudflareReady(title.id, title.name, videoId);
    return;
  }

  if (state === 'error' || video.status?.errorReasonText) {
    console.warn(
      `Cloudflare video for ${title.name} is not usable: ${
        video.status?.errorReasonText ?? video.status?.errorReasonCode ?? state
      }`,
    );
    return;
  }

  console.log(`Still processing ${title.name} (${videoId}): ${state}`);
}

async function waitForReady(titleIds: readonly string[]): Promise<void> {
  const timeoutMs =
    parsePositiveInt(process.env.CF_STREAM_COPY_TIMEOUT_MS) ??
    DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs =
    parsePositiveInt(process.env.CF_STREAM_COPY_POLL_INTERVAL_MS) ??
    DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pending = await prisma.title.findMany({
      where: {
        id: { in: [...titleIds] },
        streamVideoId: { not: null },
        pocPlaybackUrl: { not: null },
        status: TitleStatus.READY,
      },
      select: {
        id: true,
        name: true,
        streamVideoId: true,
      },
    });

    if (pending.length === 0) {
      console.log('All synced Cloudflare videos are ready.');
      return;
    }

    for (const title of pending) {
      if (!title.streamVideoId) continue;
      const video = await fetchCloudflareVideo(title.streamVideoId);
      const state = video.status?.state ?? 'unknown';
      if (video.readyToStream) {
        await markCloudflareReady(title.id, title.name, title.streamVideoId);
      } else {
        console.log(`Waiting for ${title.name}: ${state}`);
      }
    }

    await sleep(pollIntervalMs);
  }

  console.warn(
    'Timed out waiting for all Cloudflare videos. Rerun this script later; it is safe to rerun.',
  );
}

async function fetchCloudflareVideo(
  videoId: string,
): Promise<CloudflareStreamVideo> {
  return cloudflareRequest<CloudflareStreamVideo>(
    `/accounts/${accountId}/stream/${videoId}`,
    { method: 'GET' },
  );
}

async function markCloudflareReady(
  titleId: string,
  titleName: string,
  videoId: string,
): Promise<void> {
  await prisma.title.update({
    where: { id: titleId },
    data: {
      pocPlaybackUrl: null,
      streamVideoId: videoId,
      status: TitleStatus.READY,
    },
  });
  console.log(`Ready on Cloudflare: ${titleName} (${videoId})`);
}

async function cloudflareRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
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
    throw new Error(
      getCloudflareMessage(body) ??
        `Cloudflare Stream request failed with status ${response.status}.`,
    );
  }

  return body.result;
}

async function clearCatalogCache(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('REDIS_URL is not set; skipped catalog cache clear.');
    return;
  }

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  });

  redis.on('error', (error) => {
    console.warn(`Redis cache clear error: ${error.message}`);
  });

  try {
    let cursor = '0';
    let deleted = 0;
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        'MATCH',
        'catalog:*',
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += keys.length;
        await redis.del(...keys);
      }
    } while (cursor !== '0');

    console.log(`Cleared ${deleted} catalog cache key(s).`);
  } catch (error) {
    console.warn(`Could not clear catalog cache: ${getErrorMessage(error)}`);
  } finally {
    redis.disconnect();
  }
}

function appendCloudflareNote(
  licenseSource: string | null,
  videoId: string,
): string {
  const base = licenseSource ?? '';
  const note = `Cloudflare Stream video: ${videoId}.`;
  if (base.includes(note)) return base;
  return [base, note].filter(Boolean).join(' ');
}

function getCloudflareMessage<T>(
  response: CloudflareApiResponse<T> | null,
): string | null {
  const message =
    response?.errors?.find((error) => error.message)?.message ??
    response?.messages?.find((item) => item.message)?.message;
  return message ?? null;
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    value?.trim().toLowerCase() ?? '',
  );
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
