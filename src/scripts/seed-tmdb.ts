import 'dotenv/config';
import { unsafeContentReason } from '../common/content/content-safety';
import { GENRES } from '../common/constants/genres';
import {
  PrismaClient,
  TitleStatus,
  TitleType,
} from '../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma/prisma-pg-adapter';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_LANGUAGE = 'en-US';

const POC_STREAMS = [
  {
    name: 'Big Buck Bunny',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    durationSec: 596,
  },
  {
    name: 'Sintel',
    url: 'https://test-streams.mux.dev/pts_shift/master.m3u8',
    durationSec: 888,
  },
  {
    name: 'Tears of Steel',
    url: 'https://test-streams.mux.dev/tos_ismc/main.m3u8',
    durationSec: 734,
  },
  {
    name: 'Apple BipBop',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
    durationSec: 600,
  },
  {
    name: "Elephant's Dream",
    url: 'https://download.blender.org/ED/ED_1024.mp4',
    durationSec: 653,
  },
] as const;

const GENRE_ALIASES: Record<string, string> = {
  'Science Fiction': 'Sci-Fi',
};

const CANONICAL_GENRES = new Set<string>(GENRES);

interface TmdbMovieSummary {
  id: number;
  adult?: boolean;
  title?: string;
  original_title?: string;
  overview?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
}

interface TmdbMovieDetails extends TmdbMovieSummary {
  runtime?: number | null;
  genres?: Array<{ id: number; name: string }>;
}

interface TmdbMoviePage {
  page: number;
  results: TmdbMovieSummary[];
  total_pages: number;
}

interface TmdbGenreList {
  genres: Array<{ id: number; name: string }>;
}

interface TmdbConfiguration {
  images?: {
    secure_base_url?: string;
    base_url?: string;
    poster_sizes?: string[];
    backdrop_sizes?: string[];
  };
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to seed TMDB titles.');
}

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(databaseUrl),
});

async function main(): Promise<void> {
  const token = getTmdbToken();
  const language = process.env.TMDB_LANGUAGE || DEFAULT_LANGUAGE;
  const limit = parseLimit(process.env.TMDB_SEED_LIMIT);

  console.log(`Fetching ${limit} popular TMDB movies (${language})...`);

  await ensureGenres();
  await archiveExistingUnsafePocTitles();

  const [imageConfig, genreMap, movies] = await Promise.all([
    fetchImageConfig(token),
    fetchTmdbGenreMap(token, language),
    fetchPopularMovies(token, language, limit),
  ]);

  let createdOrUpdated = 0;
  let skippedUnsafe = 0;
  for (const [index, movie] of movies.entries()) {
    const details = await fetchMovieDetails(token, movie.id, language);
    const title = details ?? movie;
    const unsafeReason = unsafeContentReason({
      adult: title.adult ?? movie.adult,
      title: title.title,
      originalTitle: title.original_title,
      overview: title.overview,
    });
    if (unsafeReason) {
      await archiveTmdbTitle(movie.id, unsafeReason);
      skippedUnsafe += 1;
      console.warn(
        `Skipped unsafe TMDB title ${movie.id} (${unsafeReason}): ${title.title ?? title.original_title ?? 'Untitled'}`,
      );
      continue;
    }

    const pocStream = POC_STREAMS[index % POC_STREAMS.length];
    const genreNames = pickGenreNames(movie, details, genreMap);
    const year = parseYear(title.release_date);
    const slug = slugify(
      title.title ?? title.original_title ?? 'tmdb-title',
      year,
      movie.id,
    );
    const posterUrl = buildImageUrl(
      title.poster_path,
      imageConfig.baseUrl,
      imageConfig.posterSize,
    );
    const backdropUrl = buildImageUrl(
      title.backdrop_path,
      imageConfig.baseUrl,
      imageConfig.backdropSize,
    );

    await prisma.title.upsert({
      where: { tmdbId: movie.id },
      create: {
        tmdbId: movie.id,
        slug,
        name: title.title ?? title.original_title ?? `TMDB ${movie.id}`,
        description: emptyToNull(title.overview),
        type: TitleType.MOVIE,
        year,
        durationSec: toDurationSec(details?.runtime) ?? pocStream.durationSec,
        posterUrl,
        backdropUrl,
        pocPlaybackUrl: pocStream.url,
        status: TitleStatus.READY,
        licenseSource: buildLicenseSource(movie.id, pocStream.name),
        genres: {
          create: genreNames.map((name) => ({
            genre: { connect: { name } },
          })),
        },
      },
      update: {
        slug,
        name: title.title ?? title.original_title ?? `TMDB ${movie.id}`,
        description: emptyToNull(title.overview),
        type: TitleType.MOVIE,
        year,
        durationSec: toDurationSec(details?.runtime) ?? pocStream.durationSec,
        posterUrl,
        backdropUrl,
        pocPlaybackUrl: pocStream.url,
        status: TitleStatus.READY,
        licenseSource: buildLicenseSource(movie.id, pocStream.name),
        genres: {
          deleteMany: {},
          create: genreNames.map((name) => ({
            genre: { connect: { name } },
          })),
        },
      },
    });
    createdOrUpdated += 1;
  }

  console.log(
    `TMDB seed complete: ${createdOrUpdated} READY titles with POC playback URLs. Skipped ${skippedUnsafe} unsafe title(s).`,
  );
}

function getTmdbToken(): string {
  const token = process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_TOKEN;
  if (!token) {
    throw new Error(
      'Set TMDB_READ_ACCESS_TOKEN in .env before running npm run db:seed:tmdb.',
    );
  }
  return token;
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('TMDB_SEED_LIMIT must be a positive integer.');
  }
  return Math.min(parsed, MAX_LIMIT);
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

async function archiveExistingUnsafePocTitles(): Promise<void> {
  const titles = await prisma.title.findMany({
    where: {
      status: TitleStatus.READY,
      OR: [{ tmdbId: { not: null } }, { pocPlaybackUrl: { not: null } }],
    },
    select: {
      id: true,
      tmdbId: true,
      name: true,
      description: true,
    },
  });

  let archived = 0;
  for (const title of titles) {
    const reason = unsafeContentReason({
      title: title.name,
      description: title.description,
    });
    if (!reason) continue;

    await prisma.title.update({
      where: { id: title.id },
      data: { status: TitleStatus.ARCHIVED },
    });
    archived += 1;
    console.warn(`Archived unsafe existing title (${reason}): ${title.name}`);
  }

  if (archived > 0) {
    console.log(`Archived ${archived} unsafe existing POC title(s).`);
  }
}

async function archiveTmdbTitle(tmdbId: number, reason: string): Promise<void> {
  await prisma.title.updateMany({
    where: { tmdbId, status: TitleStatus.READY },
    data: {
      status: TitleStatus.ARCHIVED,
      licenseSource: `Archived by POC content filter: ${reason}.`,
    },
  });
}

async function fetchPopularMovies(
  token: string,
  language: string,
  limit: number,
): Promise<TmdbMovieSummary[]> {
  const movies: TmdbMovieSummary[] = [];
  let page = 1;
  let totalPages = 1;

  while (movies.length < limit && page <= totalPages) {
    const response = await tmdbGet<TmdbMoviePage>(token, '/movie/popular', {
      language,
      page,
    });
    totalPages = response.total_pages;

    for (const movie of response.results) {
      if (movie.adult) continue;
      if (isUnsafeTmdbSummary(movie)) continue;
      movies.push(movie);
      if (movies.length >= limit) break;
    }
    page += 1;
  }

  return movies;
}

function isUnsafeTmdbSummary(movie: TmdbMovieSummary): boolean {
  return (
    unsafeContentReason({
      adult: movie.adult,
      title: movie.title,
      originalTitle: movie.original_title,
      overview: movie.overview,
    }) !== null
  );
}

async function fetchMovieDetails(
  token: string,
  movieId: number,
  language: string,
): Promise<TmdbMovieDetails | null> {
  try {
    return await tmdbGet<TmdbMovieDetails>(token, `/movie/${movieId}`, {
      language,
    });
  } catch (error) {
    console.warn(
      `Skipping details for TMDB movie ${movieId}: ${getErrorMessage(error)}`,
    );
    return null;
  }
}

async function fetchTmdbGenreMap(
  token: string,
  language: string,
): Promise<Map<number, string>> {
  const response = await tmdbGet<TmdbGenreList>(token, '/genre/movie/list', {
    language,
  });
  const map = new Map<number, string>();
  for (const genre of response.genres) {
    const canonical = toCanonicalGenreName(genre.name);
    if (canonical) map.set(genre.id, canonical);
  }
  return map;
}

async function fetchImageConfig(
  token: string,
): Promise<{ baseUrl: string; posterSize: string; backdropSize: string }> {
  const response = await tmdbGet<TmdbConfiguration>(token, '/configuration');
  const images = response.images;
  const baseUrl = normalizeBaseUrl(
    images?.secure_base_url ??
      images?.base_url ??
      'https://image.tmdb.org/t/p/',
  );

  return {
    baseUrl,
    posterSize: pickImageSize(images?.poster_sizes, 'w500'),
    backdropSize: pickImageSize(images?.backdrop_sizes, 'w780'),
  };
}

async function tmdbGet<T>(
  token: string,
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(`${TMDB_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `TMDB ${response.status} ${response.statusText}: ${body.slice(0, 300)}`,
    );
  }

  return (await response.json()) as T;
}

function pickGenreNames(
  movie: TmdbMovieSummary,
  details: TmdbMovieDetails | null,
  genreMap: Map<number, string>,
): string[] {
  const names = new Set<string>();

  for (const genre of details?.genres ?? []) {
    const canonical = toCanonicalGenreName(genre.name);
    if (canonical) names.add(canonical);
  }

  for (const id of movie.genre_ids ?? []) {
    const canonical = genreMap.get(id);
    if (canonical) names.add(canonical);
  }

  return [...(names.size ? names : new Set(['Drama']))].slice(0, 3);
}

function toCanonicalGenreName(name: string): string | null {
  const alias = GENRE_ALIASES[name] ?? name;
  return CANONICAL_GENRES.has(alias) ? alias : null;
}

function buildImageUrl(
  filePath: string | null | undefined,
  baseUrl: string,
  size: string,
): string | null {
  return filePath ? `${baseUrl}${size}${filePath}` : null;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function pickImageSize(sizes: string[] | undefined, preferred: string): string {
  if (!sizes?.length) return preferred;
  if (sizes.includes(preferred)) return preferred;
  return sizes[sizes.length - 1];
}

function parseYear(releaseDate: string | undefined): number | null {
  if (!releaseDate) return null;
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function toDurationSec(runtimeMin: number | null | undefined): number | null {
  if (!runtimeMin || runtimeMin < 1) return null;
  return runtimeMin * 60;
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function slugify(title: string, year: number | null, tmdbId: number): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return [base || 'tmdb-title', year, `tmdb-${tmdbId}`]
    .filter(Boolean)
    .join('-');
}

function buildLicenseSource(tmdbId: number, streamName: string): string {
  return `POC only: metadata from TMDB movie ${tmdbId}; demo playback uses ${streamName} public/open sample stream. Replace with licensed content before production.`;
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
