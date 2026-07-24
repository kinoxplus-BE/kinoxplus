import 'dotenv/config';
import Redis from 'ioredis';
import { unsafeContentReason } from '../common/content/content-safety';
import { GENRES, type GenreName } from '../common/constants/genres';
import {
  PrismaClient,
  TitleStatus,
  TitleType,
} from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma/prisma-pg-adapter';
import {
  PUBLIC_DOMAIN_ARCHIVE_TITLES,
  type PublicDomainArchiveTitle,
} from './public-domain-archive-catalog';

const ARCHIVE_METADATA_BASE = 'https://archive.org/metadata';
const ARCHIVE_DOWNLOAD_BASE = 'https://archive.org/download';
const ARCHIVE_THUMB_BASE = 'https://archive.org/services/img';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SIZE_BYTES = 1_500_000_000;

type ArchiveMetadataValue = string | number | string[] | undefined | null;

interface ArchiveMetadata {
  title?: ArchiveMetadataValue;
  description?: ArchiveMetadataValue;
  date?: ArchiveMetadataValue;
  runtime?: ArchiveMetadataValue;
  licenseurl?: ArchiveMetadataValue;
}

interface ArchiveFile {
  name?: string;
  source?: string;
  format?: string;
  title?: string;
  length?: string | number;
  size?: string | number;
  width?: string | number;
  height?: string | number;
}

interface ArchiveMetadataResponse {
  metadata?: ArchiveMetadata;
  files?: ArchiveFile[];
  server?: string;
  dir?: string;
}

interface SelectedPlaybackFile {
  name: string;
  url: string;
  durationSec: number | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to seed Internet Archive titles.');
}

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(databaseUrl),
});

async function main(): Promise<void> {
  const titles = selectSeedTitles();
  const archiveTmdbPoc = parseBoolean(process.env.ARCHIVE_SEED_ARCHIVE_TMDB_POC);

  console.log(
    `Seeding ${titles.length} curated Internet Archive title(s) into catalog...`,
  );

  await ensureGenres();

  let seeded = 0;
  let skipped = 0;
  for (const title of titles) {
    try {
      await seedTitle(title);
      seeded += 1;
    } catch (error) {
      skipped += 1;
      console.warn(
        `Skipped ${title.name} (${title.identifier}): ${getErrorMessage(error)}`,
      );
    }
  }

  if (archiveTmdbPoc) {
    await archiveTmdbPocTitles();
    await archiveDevDemoTitles();
  }

  if (parseBoolean(process.env.ARCHIVE_SEED_ARCHIVE_DISABLED_TITLES)) {
    await archiveDisabledArchiveTitles(titles);
  }

  await clearCatalogCache();

  console.log(
    `Internet Archive seed complete: ${seeded} READY title(s), ${skipped} skipped.`,
  );
}

function selectSeedTitles(): PublicDomainArchiveTitle[] {
  const includeReview = parseBoolean(
    process.env.ARCHIVE_SEED_INCLUDE_LEGAL_REVIEW_TITLES,
  );
  const limit = parseLimit(process.env.ARCHIVE_SEED_LIMIT);

  const titles = PUBLIC_DOMAIN_ARCHIVE_TITLES.filter((title) => {
    if (title.requiresLegalReview && !includeReview) return false;
    return title.includeByDefault !== false;
  });

  return titles.slice(0, limit);
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return PUBLIC_DOMAIN_ARCHIVE_TITLES.length;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('ARCHIVE_SEED_LIMIT must be a positive integer.');
  }
  return Math.min(parsed, PUBLIC_DOMAIN_ARCHIVE_TITLES.length);
}

async function seedTitle(title: PublicDomainArchiveTitle): Promise<void> {
  const unsafeReason = unsafeContentReason({
    title: title.name,
    description: title.description,
  });
  if (unsafeReason) {
    throw new Error(`blocked by content safety filter: ${unsafeReason}`);
  }

  const archive = await fetchArchiveMetadata(title.identifier);
  const playback = selectPlaybackFile(title, archive);
  const metadata = archive.metadata ?? {};
  const description = title.description;
  const durationSec =
    playback.durationSec ?? parseDurationSec(firstString(metadata.runtime));
  const slug = slugify(title.name, title.year, title.identifier);
  const genreNames = title.genres.filter((genre) =>
    GENRES.includes(genre as GenreName),
  );

  await prisma.title.upsert({
    where: { slug },
    create: {
      slug,
      name: title.name,
      description,
      type: TitleType.MOVIE,
      year: title.year,
      durationSec,
      posterUrl: archiveThumbUrl(title.identifier),
      backdropUrl: archiveThumbUrl(title.identifier),
      pocPlaybackUrl: playback.url,
      status: TitleStatus.READY,
      licenseSource: buildLicenseSource(title, metadata, playback),
      licenseExpiry: null,
      genres: {
        create: genreNames.map((name) => ({
          genre: { connect: { name } },
        })),
      },
    },
    update: {
      name: title.name,
      description,
      type: TitleType.MOVIE,
      year: title.year,
      durationSec,
      posterUrl: archiveThumbUrl(title.identifier),
      backdropUrl: archiveThumbUrl(title.identifier),
      pocPlaybackUrl: playback.url,
      status: TitleStatus.READY,
      licenseSource: buildLicenseSource(title, metadata, playback),
      licenseExpiry: null,
      genres: {
        deleteMany: {},
        create: genreNames.map((name) => ({
          genre: { connect: { name } },
        })),
      },
    },
  });

  console.log(
    `Seeded ${title.name} (${title.year}) -> ${playback.name} (${formatSize(
      playback.sizeBytes,
    )})`,
  );
}

async function fetchArchiveMetadata(
  identifier: string,
): Promise<ArchiveMetadataResponse> {
  const url = `${ARCHIVE_METADATA_BASE}/${encodeURIComponent(identifier)}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(
      `Internet Archive returned ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as ArchiveMetadataResponse | unknown[];
  if (Array.isArray(body) || !body || typeof body !== 'object') {
    throw new Error('Internet Archive item was not found.');
  }

  const metadata = body as ArchiveMetadataResponse;
  if (!metadata.files?.length) {
    throw new Error('Internet Archive item has no downloadable files.');
  }

  return metadata;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const timeoutMs =
    parsePositiveInt(process.env.ARCHIVE_SEED_REQUEST_TIMEOUT_MS) ??
    DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function selectPlaybackFile(
  title: PublicDomainArchiveTitle,
  archive: ArchiveMetadataResponse,
): SelectedPlaybackFile {
  const maxSizeBytes =
    parsePositiveInt(process.env.ARCHIVE_SEED_MAX_SIZE_BYTES) ??
    DEFAULT_MAX_SIZE_BYTES;
  const candidates = (archive.files ?? [])
    .filter((file): file is Required<Pick<ArchiveFile, 'name'>> & ArchiveFile =>
      Boolean(file.name?.toLowerCase().endsWith('.mp4')),
    )
    .filter((file) => !isNonFeatureFile(file.name))
    .filter((file) => {
      const size = parseNumber(file.size);
      return size === null || size <= maxSizeBytes;
    })
    .map((file) => ({ file, score: scorePlaybackFile(title, file) }))
    .sort((a, b) => b.score - a.score);

  const selected = candidates[0]?.file;
  if (!selected?.name) {
    throw new Error('No usable MP4 file found for this Archive item.');
  }

  return {
    name: selected.name,
    url: archiveDownloadUrl(title.identifier, selected.name),
    durationSec: parseDurationSec(selected.length),
    sizeBytes: parseNumber(selected.size),
    width: parseNumber(selected.width),
    height: parseNumber(selected.height),
  };
}

function scorePlaybackFile(
  title: PublicDomainArchiveTitle,
  file: ArchiveFile,
): number {
  const name = file.name ?? '';
  const lowerName = name.toLowerCase();
  const format = String(file.format ?? '').toLowerCase();
  const width = parseNumber(file.width);
  const height = parseNumber(file.height);
  const size = parseNumber(file.size);
  let score = 0;

  if (title.preferredFileNames?.includes(name)) score += 10_000;
  if (format.includes('h.264') || format.includes('mpeg4')) score += 1_000;
  if (file.source === 'derivative') score += 500;
  if (lowerName.includes('.ia.mp4')) score += 300;
  if (width && height) {
    if (width >= 480 && width <= 1280) score += 250;
    if (height >= 360 && height <= 720) score += 250;
    score += Math.min(width * height, 921_600) / 10_000;
  }
  if (size) {
    score += Math.max(0, 300 - size / 5_000_000);
  }

  return score;
}

function isNonFeatureFile(name: string): boolean {
  const lower = name.toLowerCase();
  return [
    'sample',
    'trailer',
    'featurette',
    'deleted',
    'clip',
    'fragment',
    'short',
    'yts',
    'yify',
    'rarbg',
    'bluray',
    'brrip',
  ].some((term) => lower.includes(term));
}

async function ensureGenres(): Promise<void> {
  for (const name of GENRES) {
    await prisma.genre.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }
}

async function archiveTmdbPocTitles(): Promise<void> {
  const result = await prisma.title.updateMany({
    where: {
      status: TitleStatus.READY,
      tmdbId: { not: null },
      licenseSource: { startsWith: 'POC only:' },
    },
    data: {
      status: TitleStatus.ARCHIVED,
      licenseSource:
        'Archived by Internet Archive seed so only genuinely playable catalog titles are shown.',
    },
  });

  console.log(`Archived ${result.count} old TMDB demo-mismatch title(s).`);
}

async function archiveDevDemoTitles(): Promise<void> {
  const result = await prisma.title.updateMany({
    where: {
      status: TitleStatus.READY,
      OR: [
        { slug: 'demo-title' },
        { licenseSource: { startsWith: 'DEV SEED' } },
      ],
    },
    data: {
      status: TitleStatus.ARCHIVED,
      licenseSource:
        'Archived by Internet Archive seed so only genuine playable catalog titles are shown.',
    },
  });

  console.log(`Archived ${result.count} dev demo title(s).`);
}

async function archiveDisabledArchiveTitles(
  selectedTitles: readonly PublicDomainArchiveTitle[],
): Promise<void> {
  const selectedIdentifiers = new Set(
    selectedTitles.map((title) => title.identifier),
  );
  let archived = 0;

  for (const title of PUBLIC_DOMAIN_ARCHIVE_TITLES) {
    if (selectedIdentifiers.has(title.identifier)) continue;

    const result = await prisma.title.updateMany({
      where: {
        status: TitleStatus.READY,
        licenseSource: {
          contains: `Internet Archive curated seed: ${title.identifier}.`,
        },
      },
      data: {
        status: TitleStatus.ARCHIVED,
        licenseSource: `Archived by Internet Archive seed pending rights/source review. Original identifier: ${title.identifier}.`,
      },
    });
    archived += result.count;
  }

  console.log(`Archived ${archived} disabled/review Archive title(s).`);
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
  title: PublicDomainArchiveTitle,
  metadata: ArchiveMetadata,
  playback: SelectedPlaybackFile,
): string {
  const archiveLicense = firstString(metadata.licenseurl);
  const sourceUrls = [
    `https://archive.org/details/${title.identifier}`,
    ...title.rightsSourceUrls,
  ];

  return [
    `Internet Archive curated seed: ${title.identifier}.`,
    `Rights note: ${title.rightsNote}`,
    archiveLicense ? `Archive license URL: ${archiveLicense}.` : null,
    `Playback file: ${playback.name}.`,
    `Sources: ${dedupe(sourceUrls).join(' | ')}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function archiveDownloadUrl(identifier: string, fileName: string): string {
  return `${ARCHIVE_DOWNLOAD_BASE}/${encodeURIComponent(
    identifier,
  )}/${encodeArchivePath(fileName)}`;
}

function archiveThumbUrl(identifier: string): string {
  return `${ARCHIVE_THUMB_BASE}/${encodeURIComponent(identifier)}`;
}

function encodeArchivePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function firstString(value: ArchiveMetadataValue): string | null {
  if (Array.isArray(value)) {
    return emptyToNull(value[0]);
  }
  if (typeof value === 'number') return String(value);
  return emptyToNull(value);
}

function emptyToNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseDurationSec(value: ArchiveMetadataValue): number | null {
  const raw = firstString(value);
  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number.parseFloat(raw);
    return Math.round(numeric);
  }

  const parts = raw.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseNumber(value: ArchiveMetadataValue): number | null {
  const raw = firstString(value);
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
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

function slugify(title: string, year: number, identifier: string): string {
  const base = `${title}-${year}-archive-${identifier}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return base || `archive-${identifier}`;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatSize(sizeBytes: number | null): string {
  if (!sizeBytes) return 'unknown size';
  const mb = sizeBytes / 1_000_000;
  return `${mb.toFixed(1)} MB`;
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
