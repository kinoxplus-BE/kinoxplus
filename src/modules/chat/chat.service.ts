import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Room text chat (rides Socket.io — see RoomsGateway).
 * [POST-MVP] Direct messages / full messaging platform lands here.
 */
@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  addMessage(roomId: string, userId: string, body: string) {
    return this.prisma.chatMessage.create({
      data: { roomId, userId, body },
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
  }

  history(roomId: string, limit = 50, cursor?: string) {
    return this.prisma.chatMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        user: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });
  }
}
