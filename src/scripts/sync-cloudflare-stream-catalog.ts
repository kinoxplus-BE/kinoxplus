import 'dotenv/config';
import Redis from 'ioredis';
import { unsafeContentReason } from '../common/content/content-safety';
import { GENRES, type GenreName } from '../common/constants/genres';
import {
  PrismaClient,
  TitleStatus,
  TitleType,
  type Title,
} from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma/prisma-pg-adapter';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_LIMIT = 1000;
const DEFAULT_GENRES: GenreName[] = ['Drama'];

type CloudflareApiError = {
  code?: number;
  message?: string;
};

type CloudflareApiResponse<T> = {
  success: boolean;
  result?: T;
  errors?: CloudflareApiError[];
  messages?: CloudflareApiError[];
  total?: number;
  range?: number;
};

type CloudflareStreamStatus = {
  state?: string;
  errorReasonCode?: string;
  errorReasonText?: string;
  pctComplete?: string;
};

type CloudflareStreamVideo = {
  uid?: string;
  duration?: number;
  meta?: Record<string, unknown>;
  publicDetails?: {
    title?: string;
  };
  readyToStream?: boolean;
  requireSignedURLs?: boolean;
  status?: CloudflareStreamStatus;
  thumbnail?: string;
  created?: string;
  modified?: string;
};

type ExistingTitle = Pick<
  Title,
  | 'id'
  | 'slug'
  | 'name'
  | 'description'
  | 'year'
  | 'durationSec'
  | 'posterUrl'
  | 'backdropUrl'
  | 'streamVideoId'
  | 'status'
  | 'licenseSource'
  | 'licenseExpiry'
>;

type SyncStats = {
  created: number;
  updated: number;
  skipped: number;
  draft: number;
  ready: number;
};

type SyncResult = {
  action: 'created' | 'updated';
  status: TitleStatus;
};

const PIRACY_SOURCE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'unofficial movie download host marker', pattern: /\bfzmovies?\b/i },
  { label: 'torrent release group marker', pattern: /\b(?:yts|yify|rarbg)\b/i },
  { label: 'torrent/source marker', pattern: /\btorrent\b/i },
  {
    label: 'unauthorized release marker',
    pattern: /\b(?:web-?dl|web-?rip|hd-?rip|br-?rip|dvd-?rip|cam-?rip)\b/i,
  },
  { label: 'disc-rip marker', pattern: /\bblu[-\s]?ray\b/i },
  {
    label: 'unofficial download URL marker',
    pattern: /\b(?:fromwebsite|download[-_\s]?movie|free[-_\s]?movie)\b/i,
  },
];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to sync Cloudflare Stream videos.');
}

const accountId = process.env.CF_ACCOUNT_ID;
if (!accountId) {
  throw new Error(
    'CF_ACCOUNT_ID is required to sync Cloudflare Stream videos.',
  );
}

const apiToken = process.env.CF_STREAM_API_TOKEN;
if (!apiToken) {
  throw new Error(
    'CF_STREAM_API_TOKEN is required to sync Cloudflare Stream videos.',
  );
}

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(databaseUrl),
});

async function main(): Promise<void> {
  const options = getSyncOptions();
  const videos = await listCloudflareVideos(options);

  if (videos.length === 0) {
    console.log('No Cloudflare Stream videos found for this sync.');
    return;
  }

  await ensureGenres();

  const stats: SyncStats = {
    created: 0,
    updated: 0,
    skipped: 0,
    draft: 0,
    ready: 0,
  };

  console.log(
    `Syncing ${videos.length} Cloudflare Stream video(s) into KinoX catalog...`,
  );

  for (const video of videos) {
    try {
      const result = await syncVideo(video, options);
      stats[result.action] += 1;
      if (result.status === TitleStatus.READY) {
        stats.ready += 1;
      } else {
        stats.draft += 1;
      }
    } catch (error) {
      stats.skipped += 1;
      console.warn(
        `Skipped Cloudflare video ${video.uid ?? 'unknown'}: ${getErrorMessage(
          error,
        )}`,
      );
    }
  }

  if (!options.dryRun) {
    await clearCatalogCache();
  }

  console.log(
    `Cloudflare sync complete: ${stats.created} created, ${stats.updated} updated, ${stats.ready} READY, ${stats.draft} DRAFT/review, ${stats.skipped} skipped.`,
  );
}

function getSyncOptions() {
  return {
    limit: parsePositiveInt(process.env.CF_STREAM_SYNC_LIMIT) ?? DEFAULT_LIMIT,
    search: emptyToNull(process.env.CF_STREAM_SYNC_SEARCH),
    status: emptyToNull(process.env.CF_STREAM_SYNC_STATUS),
    publishReady: parseBoolean(process.env.CF_STREAM_SYNC_PUBLISH_READY),
    defaultLicenseSource: emptyToNull(
      process.env.CF_STREAM_SYNC_LICENSE_SOURCE,
    ),
    requireSignedUrls:
      process.env.CF_STREAM_SYNC_REQUIRE_SIGNED_URLS === undefined
        ? true
        : parseBoolean(process.env.CF_STREAM_SYNC_REQUIRE_SIGNED_URLS),
    overwriteMetadata: parseBoolean(
      process.env.CF_STREAM_SYNC_OVERWRITE_METADATA,
    ),
    dryRun: parseBoolean(process.env.CF_STREAM_SYNC_DRY_RUN),
    defaultGenres:
      parseGenres(process.env.CF_STREAM_SYNC_DEFAULT_GENRES) ?? DEFAULT_GENRES,
  };
}

async function listCloudflareVideos(
  options: ReturnType<typeof getSyncOptions>,
): Promise<CloudflareStreamVideo[]> {
  const params = new URLSearchParams({
    limit: String(Math.min(options.limit, DEFAULT_LIMIT)),
  });

  if (options.search) params.set('search', options.search);
  if (options.status) params.set('status', options.status);

  const response = await cloudflareRequest<CloudflareStreamVideo[]>(
    `/accounts/${accountId}/stream?${params.toString()}`,
    { method: 'GET' },
  );

  return response.filter((video) => Boolean(video.uid));
}

async function syncVideo(
  video: CloudflareStreamVideo,
  options: ReturnType<typeof getSyncOptions>,
): Promise<SyncResult> {
  const uid = video.uid;
  if (!uid) {
    throw new Error('Cloudflare video has no uid.');
  }

  const metadata = buildTitleMetadata(video, options.defaultGenres);
  const unsafeReason = unsafeContentReason({
    title: metadata.name,
    description: metadata.description,
  });
  if (unsafeReason) {
    throw new Error(`blocked by content safety filter: ${unsafeReason}`);
  }

  //PRIVACY SOURCE CHECK DISABLED FOR NOW
  const piracyReason = suspiciousSourceReason(video, metadata.name);
  if (piracyReason) {
    throw new Error(`blocked by source safety filter: ${piracyReason}`);
  }

  const licenseSource = buildLicenseSource(video, options.defaultLicenseSource);
  const canPublish = Boolean(options.publishReady && licenseSource);
  const status = getTitleStatus(video, canPublish);
  const existing = await findExistingTitle(uid, metadata.slug);
  const slug = await getUsableSlug(metadata.slug, uid, existing);

  if (options.requireSignedUrls && video.requireSignedURLs !== true) {
    if (options.dryRun) {
      console.log(`Would require signed URLs for ${metadata.name} (${uid}).`);
    } else {
      await updateCloudflareVideo(uid, { uid, requireSignedURLs: true });
    }
  }

  if (options.dryRun) {
    console.log(
      `Would sync ${metadata.name} (${uid}) as ${status}; license=${licenseSource ? 'yes' : 'missing'}.`,
    );
    return { action: existing ? 'updated' : 'created', status };
  }

  const genreNames = metadata.genres;

  if (existing) {
    const nextStatus =
      existing.status === TitleStatus.READY && video.readyToStream
        ? TitleStatus.READY
        : status;
    await prisma.title.update({
      where: { id: existing.id },
      data: {
        streamVideoId: uid,
        pocPlaybackUrl: null,
        status: nextStatus,
        type: TitleType.MOVIE,
        name: options.overwriteMetadata ? metadata.name : existing.name,
        description: pickMetadataValue(
          options.overwriteMetadata,
          existing.description,
          metadata.description,
        ),
        year: pickMetadataValue(
          options.overwriteMetadata,
          existing.year,
          metadata.year,
        ),
        durationSec: pickMetadataValue(
          options.overwriteMetadata,
          existing.durationSec,
          metadata.durationSec,
        ),
        posterUrl: pickMetadataValue(
          options.overwriteMetadata,
          existing.posterUrl,
          metadata.posterUrl,
        ),
        backdropUrl: pickMetadataValue(
          options.overwriteMetadata,
          existing.backdropUrl,
          metadata.backdropUrl,
        ),
        licenseSource:
          licenseSource ??
          existing.licenseSource ??
          unreviewedLicenseSource(uid),
        licenseExpiry: existing.licenseExpiry,
        ...(options.overwriteMetadata
          ? {
              genres: {
                deleteMany: {},
                create: genreNames.map((name) => ({
                  genre: { connect: { name } },
                })),
              },
            }
          : {}),
      },
    });

    console.log(
      `Updated ${metadata.name} (${uid}) -> ${nextStatus}${
        licenseSource ? '' : ' (license review needed)'
      }`,
    );
    return { action: 'updated', status: nextStatus };
  }

  await prisma.title.create({
    data: {
      slug,
      name: metadata.name,
      description: metadata.description,
      type: TitleType.MOVIE,
      year: metadata.year,
      durationSec: metadata.durationSec,
      posterUrl: metadata.posterUrl,
      backdropUrl: metadata.backdropUrl,
      streamVideoId: uid,
      pocPlaybackUrl: null,
      status,
      licenseSource: licenseSource ?? unreviewedLicenseSource(uid),
      licenseExpiry: null,
      genres: {
        create: genreNames.map((name) => ({
          genre: { connect: { name } },
        })),
      },
    },
  });

  console.log(
    `Created ${metadata.name} (${uid}) -> ${status}${
      licenseSource ? '' : ' (license review needed)'
    }`,
  );

  return { action: 'created', status };
}

function buildTitleMetadata(
  video: CloudflareStreamVideo,
  defaultGenres: GenreName[],
) {
  const rawName =
    getMetaString(video.meta, 'title') ??
    video.publicDetails?.title ??
    getMetaString(video.meta, 'name') ??
    video.uid ??
    'Untitled Cloudflare Video';
  const name = cleanTitleName(rawName);
  const year = parseYear(getMetaString(video.meta, 'year')) ?? parseYear(name);
  const durationSec =
    typeof video.duration === 'number' && video.duration > 0
      ? Math.round(video.duration)
      : null;
  const description =
    getMetaString(video.meta, 'description') ??
    'Cloudflare Stream video synced into the KinoX catalog.';
  const posterUrl =
    getMetaString(video.meta, 'posterUrl') ??
    getMetaString(video.meta, 'poster') ??
    video.thumbnail ??
    null;
  const backdropUrl =
    getMetaString(video.meta, 'backdropUrl') ??
    getMetaString(video.meta, 'backdrop') ??
    posterUrl;
  const genres =
    parseGenres(getMetaString(video.meta, 'genres')) ?? defaultGenres;
  const slug = slugify(
    getMetaString(video.meta, 'slug') ?? [name, year].filter(Boolean).join(' '),
    video.uid ?? 'cloudflare',
  );

  return {
    name,
    year,
    durationSec,
    description,
    posterUrl,
    backdropUrl,
    genres,
    slug,
  };
}

function getTitleStatus(
  video: CloudflareStreamVideo,
  canPublish: boolean,
): TitleStatus {
  if (video.status?.state === 'error') return TitleStatus.ARCHIVED;
  if (!video.readyToStream) return TitleStatus.PROCESSING;
  return canPublish ? TitleStatus.READY : TitleStatus.DRAFT;
}

async function findExistingTitle(
  streamVideoId: string,
  slug: string,
): Promise<ExistingTitle | null> {
  const byVideoId = await prisma.title.findUnique({
    where: { streamVideoId },
    select: EXISTING_TITLE_SELECT,
  });
  if (byVideoId) return byVideoId;

  return prisma.title.findUnique({
    where: { slug },
    select: EXISTING_TITLE_SELECT,
  });
}

async function getUsableSlug(
  slug: string,
  streamVideoId: string,
  existing: ExistingTitle | null,
): Promise<string> {
  if (existing) return existing.slug;

  const current = await prisma.title.findUnique({
    where: { slug },
    select: { streamVideoId: true },
  });
  if (!current || current.streamVideoId === streamVideoId) return slug;

  return `${slug}-${streamVideoId.slice(0, 8)}`;
}

const EXISTING_TITLE_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  year: true,
  durationSec: true,
  posterUrl: true,
  backdropUrl: true,
  streamVideoId: true,
  status: true,
  licenseSource: true,
  licenseExpiry: true,
} satisfies Record<keyof ExistingTitle, true>;

async function ensureGenres(): Promise<void> {
  for (const name of GENRES) {
    await prisma.genre.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }
}

async function updateCloudflareVideo(
  videoId: string,
  body: Record<string, unknown>,
): Promise<void> {
  await cloudflareRequest<CloudflareStreamVideo>(
    `/accounts/${accountId}/stream/${videoId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

async function cloudflareRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(init.headers ?? {}),
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

function buildLicenseSource(
  video: CloudflareStreamVideo,
  defaultLicenseSource: string | null,
): string | null {
  const license =
    getMetaString(video.meta, 'licenseSource') ??
    getMetaString(video.meta, 'license') ??
    getMetaString(video.meta, 'rights') ??
    defaultLicenseSource;

  if (!license || !video.uid) return null;

  return [
    `Cloudflare Stream synced video: ${video.uid}.`,
    `Rights note: ${license}.`,
    video.created ? `Cloudflare uploaded: ${video.created}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

function unreviewedLicenseSource(videoId: string): string {
  return `Cloudflare Stream synced video: ${videoId}. Pending license review; not published to catalog until marked READY with a rights source.`;
}

function suspiciousSourceReason(
  video: CloudflareStreamVideo,
  titleName: string,
): string | null {
  const text = [
    titleName,
    video.uid,
    video.status?.errorReasonText,
    video.meta ? Object.values(video.meta).join(' ') : '',
  ]
    .filter(Boolean)
    .join(' ');

  for (const { label, pattern } of PIRACY_SOURCE_PATTERNS) {
    if (pattern.test(text)) return label;
  }

  return null;
}

function getMetaString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = meta?.[key];
  if (typeof value === 'string') return emptyToNull(value);
  if (typeof value === 'number') return String(value);
  return null;
}

function cleanTitleName(rawName: string): string {
  const withoutExtension = rawName.replace(/\.[a-z0-9]{2,5}$/i, '');
  return withoutExtension.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseYear(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/\b(19\d{2}|20\d{2})\b/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : null;
}

function parseGenres(value: string | undefined | null): GenreName[] | null {
  if (!value) return null;
  const selected = value
    .split(',')
    .map((genre) => genre.trim())
    .filter((genre): genre is GenreName => GENRES.includes(genre as GenreName));
  return selected.length > 0 ? [...new Set(selected)] : null;
}

function pickMetadataValue<T>(
  overwrite: boolean,
  existing: T | null,
  incoming: T | null,
): T | null {
  if (overwrite) return incoming ?? existing;
  return existing ?? incoming;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || `cloudflare-${fallback}`;
}

function getCloudflareMessage<T>(
  response: CloudflareApiResponse<T> | null,
): string | null {
  const message =
    response?.errors?.find((error) => error.message)?.message ??
    response?.messages?.find((item) => item.message)?.message;
  return message ?? null;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    value?.trim().toLowerCase() ?? '',
  );
}

function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
