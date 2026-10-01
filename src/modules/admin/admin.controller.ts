import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, RoomStatus, SubStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

/** Body for POST /admin/users/:userId/role — promotes/demotes a user. */
class UpdateRoleDto {
  @IsIn([Role.USER, Role.ADMIN, Role.SUPPORT])
  role!: Role;
}

/** Overview response cached in Redis for 30s. Admins typically refresh the
 *  dashboard several times per minute — one slow query path is enough. */
const OVERVIEW_CACHE_KEY = 'admin:overview:v2';
const OVERVIEW_CACHE_TTL_SEC = 30;

/**
 * Admin-only endpoints. The admin portal (Next.js app) consumes these to
 * replace its fixture data. Protected by @Roles(ADMIN, SUPPORT).
 */
@ApiTags('Admin')
@ApiBearerAuth()
@Roles(Role.ADMIN, Role.SUPPORT)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Operations overview — the hero numbers for the admin dashboard',
    description:
      'Replaces the fixture overview on admin.kinoxplus.com. Real counts for users, titles, live rooms, subscriptions, watch hours, MRR, and 7-day signups. Cached in Redis for 30s to absorb dashboard auto-refresh.',
  })
  async overview() {
    try {
      const cached = await this.redis.client.get(OVERVIEW_CACHE_KEY);
      if (cached) return JSON.parse(cached) as Record<string, unknown>;
    } catch {
      // Redis miss / blip — fall through to a fresh read.
    }
    const value = await this.computeOverview();
    try {
      await this.redis.client.set(
        OVERVIEW_CACHE_KEY,
        JSON.stringify(value),
        'EX',
        OVERVIEW_CACHE_TTL_SEC,
      );
    } catch {
      // Non-fatal: next call will try to cache again.
    }
    return value;
  }

  private async computeOverview() {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalTitles,
      liveRooms,
      watchAgg,
      activeSubs,
      signupsLast7d,
      // DAU approximation. See `caveats.dauMethod` in the response so admin
      // viewers know the number has limits.
      dauRows,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.title.count(),
      this.prisma.room.count({
        where: {
          status: {
            in: [RoomStatus.LOBBY, RoomStatus.PLAYING, RoomStatus.PAUSED],
          },
        },
      }),
      this.prisma.watchHistory.aggregate({ _sum: { positionSec: true } }),
      this.prisma.subscription.findMany({
        where: { status: SubStatus.ACTIVE },
        select: {
          plan: {
            select: { tier: true, priceKobo: true, intervalDays: true },
          },
        },
      }),
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.refreshToken.findMany({
        where: { revokedAt: null, lastUsedAt: { gte: yesterday } },
        select: { userId: true },
        distinct: ['userId'],
        orderBy: { userId: 'asc' },
      }),
    ]);

    const totalHoursWatched = Math.floor(
      (watchAgg._sum.positionSec ?? 0) / 3600,
    );

    // MRR normalised to a 30-day month. A plan billed every 7 days
    // contributes ~4.3x its charge; a 60-day plan contributes 0.5x.
    const mrrKobo = activeSubs.reduce((sum, s) => {
      const price = s.plan?.priceKobo ?? 0;
      const interval = s.plan?.intervalDays ?? 30;
      return sum + Math.round((price * 30) / interval);
    }, 0);

    const planMix = activeSubs.reduce<Record<string, number>>((acc, s) => {
      const tier = s.plan?.tier ?? 'UNKNOWN';
      acc[tier] = (acc[tier] ?? 0) + 1;
      return acc;
    }, {});

    return {
      asOf: now.toISOString(),
      users: {
        total: totalUsers,
        dau: dauRows.length,
        signupsLast7d,
      },
      content: {
        totalTitles,
        totalHoursWatched,
      },
      rooms: {
        liveNow: liveRooms,
      },
      revenue: {
        mrrKobo,
        mrrNaira: Math.floor(mrrKobo / 100),
        activeSubscriptions: activeSubs.length,
        planMix,
      },
      caveats: {
        dauMethod:
          'Distinct users with a refresh-token activity ping in the last 24h. Short sessions whose access token never expired may not be counted.',
      },
    };
  }

  @Roles(Role.ADMIN)
  @Post('users/:userId/role')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set a user role',
    description:
      'ADMIN-only. SUPPORT role can read dashboard data but cannot change roles. Returns the updated user.',
  })
  async setRole(@Param('userId') userId: string, @Body() dto: UpdateRoleDto) {
    if (!userId) {
      throw new BadRequestException({
        code: 'USER_ID_REQUIRED',
        message: 'userId is required.',
      });
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
      },
    });
    // Overview counts don't change, but admin lists do — bust the cache
    // defensively so a role change is immediately visible.
    try {
      await this.redis.client.del(OVERVIEW_CACHE_KEY);
    } catch {
      // Non-fatal.
    }
    return updated;
  }
}
