import { Injectable, NotFoundException } from '@nestjs/common';
import { TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const WATCHLIST_TITLE_SELECT = {
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
} as const;

@Injectable()
export class WatchlistService {
  constructor(private readonly prisma: PrismaService) {}

  /** User's saved-for-later list, newest first, cursor-paginated. Includes
   *  the full Title row so the mobile app renders a card without a
   *  follow-up fetch. */
  async list(userId: string, cursor?: string, limit?: number) {
    const take = Math.min(limit ?? 50, 100);
    const rows = await this.prisma.watchlistItem.findMany({
      where: { userId },
      // Tie-break on id so the cursor is deterministic when two items share
      // a createdAt timestamp.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { title: { select: WATCHLIST_TITLE_SELECT } },
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      data: page.map((row) => ({ addedAt: row.createdAt, title: row.title })),
      meta: {
        nextCursor: hasMore ? page[page.length - 1].id : null,
      },
    };
  }

  /** True if the user has this title saved — used by the "Add to list" button
   *  so it renders in the right state on title detail. */
  async check(userId: string, titleId: string) {
    const existing = await this.prisma.watchlistItem.findUnique({
      where: { userId_titleId: { userId, titleId } },
      select: { id: true, createdAt: true },
    });
    return {
      saved: Boolean(existing),
      addedAt: existing?.createdAt ?? null,
    };
  }

  /** Add a title to the user's list. Idempotent — adding twice returns the
   *  existing row rather than throwing, so a client retry doesn't surface a
   *  409 the user shouldn't care about. */
  async add(userId: string, titleId: string) {
    const title = await this.prisma.title.findUnique({
      where: { id: titleId },
      select: { id: true, status: true },
    });
    if (!title || title.status !== TitleStatus.READY) {
      throw new NotFoundException({
        code: 'TITLE_NOT_FOUND',
        message: 'Title not found.',
      });
    }
    try {
      await this.prisma.watchlistItem.create({ data: { userId, titleId } });
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code !== 'P2002'
      ) {
        throw err;
      }
      // P2002 — already on list, treat as success.
    }
    return this.check(userId, titleId);
  }

  async remove(userId: string, titleId: string) {
    const result = await this.prisma.watchlistItem.deleteMany({
      where: { userId, titleId },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        code: 'NOT_ON_WATCHLIST',
        message: 'That title is not on your list.',
      });
    }
    return { removed: true };
  }

  count(userId: string): Promise<number> {
    return this.prisma.watchlistItem.count({ where: { userId } });
  }
}
