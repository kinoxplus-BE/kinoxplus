import { Injectable, NotFoundException } from '@nestjs/common';
import type { CursorPaginationDto } from '../../common/dto/pagination.dto';
import { TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

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

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Browsable catalog — READY titles only, cursor-paginated. */
  async listTitles({ cursor, limit }: CursorPaginationDto) {
    const titles = await this.prisma.title.findMany({
      where: { status: TitleStatus.READY },
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

  async getBySlug(slug: string) {
    const title = await this.prisma.title.findUnique({
      where: { slug },
      select: publicTitleSelect,
    });
    if (!title || title.status !== TitleStatus.READY) {
      throw new NotFoundException({
        code: 'TITLE_NOT_FOUND',
        message: 'Title not found.',
      });
    }
    return title;
  }

  listGenres() {
    return this.prisma.genre.findMany({ orderBy: { name: 'asc' } });
  }
}
