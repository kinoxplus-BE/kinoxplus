import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UNSAFE_CATALOG_CONTAINS_TERMS } from '../../common/content/content-safety';
import type { GenreName } from '../../common/constants/genres';
import type { CursorPaginationDto } from '../../common/dto/pagination.dto';
import { TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

const publicTitleSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  type: true,
  year: true,
  durationSec: true,
  posterUrl: true,
  backdropUrl: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  genres: { include: { genre: true } },
} as const;

const safeReadyTitleWhere = {
  status: TitleStatus.READY,
  NOT: UNSAFE_CATALOG_CONTAINS_TERMS.flatMap((term) => [
    { name: { contains: term, mode: 'insensitive' as const } },
    { description: { contains: term, mode: 'insensitive' as const } },
  ]),
} as const;

const HOME_GENRE_ROWS: GenreName[] = [
  'Action',
  'Comedy',
  'Drama',
  'Family',
  'Animation',
  'Romance',
  'Thriller',
  'Sci-Fi',
  'Documentary',
];

interface CatalogTitleFilters extends CursorPaginationDto {
  genre?: GenreName;
}

interface CatalogHomeOptions {
  limitPerGenre: number;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly catalogCacheTtlSec: number;
  private readonly catalogCacheTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.catalogCacheTtlSec = config.get<number>('CATALOG_CACHE_TTL_SEC') ?? 300;
    this.catalogCacheTimeoutMs =
      config.get<number>('CATALOG_CACHE_TIMEOUT_MS') ?? 150;
  }

  /** Browsable catalog: READY titles only, cursor-paginated. */
  async listTitles({ cursor, limit, genre }: CatalogTitleFilters) {
    const cacheKey = [
      'catalog:titles:v2',
      `limit:${limit}`,
      `cursor:${cursor ?? 'first'}`,
      `genre:${genre ?? 'all'}`,
    ].join(':');

    return this.cached(cacheKey, () =>
      this.loadTitles({ cursor, limit, genre }),
    );
  }

  async getBySlug(slug: string) {
    const title = await this.cached(`catalog:title:v2:${slug}`, () =>
      this.prisma.title.findUnique({
        where: { slug },
        select: publicTitleSelect,
      }),
    );
    if (!title || title.status !== TitleStatus.READY || isUnsafeTitle(title)) {
      throw new NotFoundException({
        code: 'TITLE_NOT_FOUND',
        message: 'Title not found.',
      });
    }
    return title;
  }

  async home({ limitPerGenre }: CatalogHomeOptions) {
    return this.cached(`catalog:home:v1:limit:${limitPerGenre}`, async () => {
      const rows = await Promise.all(
        HOME_GENRE_ROWS.map(async (genre) => {
          const { data: titles } = await this.listTitles({
            genre,
            limit: limitPerGenre,
          });
          return { genre, titles };
        }),
      );

      return { rows: rows.filter((row) => row.titles.length > 0) };
    });
  }

  listGenres() {
    return this.cached('catalog:genres:v1', () =>
      this.prisma.genre.findMany({ orderBy: { name: 'asc' } }),
    );
  }

  private async loadTitles({ cursor, limit, genre }: CatalogTitleFilters) {
    const titles = await this.prisma.title.findMany({
      where: {
        ...safeReadyTitleWhere,
        ...(genre ? { genres: { some: { genre: { name: genre } } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: publicTitleSelect,
    });

    const hasMore = titles.length > limit;
    const page = hasMore ? titles.slice(0, limit) : titles;
    return {
      data: page,
      meta: { nextCursor: hasMore ? page[page.length - 1].id : null },
    };
  }

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (this.catalogCacheTtlSec <= 0) {
      return loader();
    }

    try {
      const cached = await this.withCacheTimeout(this.redis.client.get(key));
      if (cached) {
        try {
          return JSON.parse(cached) as T;
        } catch {
          await this.withCacheTimeout(this.redis.client.del(key));
        }
      }
    } catch (error) {
      this.logger.warn(
        `Catalog cache read failed for ${key}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }

    const value = await loader();
    try {
      await this.withCacheTimeout(
        this.redis.client.set(
          key,
          JSON.stringify(value),
          'EX',
          this.cacheTtlWithJitter(),
        ),
      );
    } catch (error) {
      this.logger.warn(
        `Catalog cache write failed for ${key}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
    return value;
  }

  private cacheTtlWithJitter(): number {
    const jitter = Math.floor(
      Math.random() * Math.min(60, Math.max(1, this.catalogCacheTtlSec * 0.1)),
    );
    return this.catalogCacheTtlSec + jitter;
  }

  private async withCacheTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('cache command timed out')),
        this.catalogCacheTimeoutMs,
      );
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function isUnsafeTitle(title: {
  name: string;
  description: string | null;
}): boolean {
  const text = `${title.name} ${title.description ?? ''}`.toLowerCase();
  return UNSAFE_CATALOG_CONTAINS_TERMS.some((term) => text.includes(term));
}
