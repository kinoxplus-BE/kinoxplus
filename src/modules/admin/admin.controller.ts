import { Controller, Get } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, RoomStatus, SubStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Admin-only endpoints. TODO(sprint-7): title CRUD/ingest management, user
 * moderation, audit log for every admin action.
 */
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  async overview() {
    const [users, titles, liveRooms, activeSubscriptions] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.title.count(),
      this.prisma.room.count({
        where: {
          status: {
            in: [RoomStatus.LOBBY, RoomStatus.PLAYING, RoomStatus.PAUSED],
          },
        },
      }),
      this.prisma.subscription.count({ where: { status: SubStatus.ACTIVE } }),
    ]);
    return { users, titles, liveRooms, activeSubscriptions };
  }
}
