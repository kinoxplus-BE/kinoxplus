import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RoomStatus, TitleStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

/** Authoritative playback state, cached in Redis for hot reads. */
export interface PlaybackState {
  positionSec: number;
  isPlaying: boolean;
  /** Server clock (ms epoch) when this state was written. */
  lastSyncAt: number;
}

const MEMBER_USER_SELECT = {
  id: true,
  displayName: true,
  avatarUrl: true,
} as const;

// No 0/O/1/I/L — codes get read out loud over voice chat.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PRESENCE_TTL_SEC = 60 * 60 * 6;

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ---------- Redis keys (AGENTS.md §6) ----------
  private stateKey(roomId: string) {
    return `room:${roomId}:state`;
  }
  private membersKey(roomId: string) {
    return `room:${roomId}:members`;
  }
  private presenceKey(userId: string) {
    return `presence:user:${userId}`;
  }

  // ---------- Lifecycle ----------
  async createRoom(
    hostId: string,
    titleId: string,
    opts: { isPrivate?: boolean; maxMembers?: number } = {},
  ) {
    const title = await this.prisma.title.findUnique({
      where: { id: titleId },
    });
    if (!title || title.status !== TitleStatus.READY) {
      throw new NotFoundException({
        code: 'TITLE_NOT_FOUND',
        message: 'Title not found or not ready for playback.',
      });
    }

    // Retry on the (unlikely) unique-code collision.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.room.create({
          data: {
            code: this.generateCode(),
            hostId,
            titleId,
            isPrivate: opts.isPrivate ?? true,
            maxMembers: opts.maxMembers ?? 20,
            members: { create: { userId: hostId } },
          },
          include: { title: { select: { id: true, name: true, slug: true } } },
        });
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new ConflictException({
      code: 'ROOM_CODE_COLLISION',
      message: 'Could not allocate a room code, try again.',
    });
  }

  async findByCode(code: string) {
    const room = await this.prisma.room.findUnique({
      where: { code: code.toUpperCase() },
      include: { title: { select: { id: true, name: true, slug: true } } },
    });
    if (!room || room.status === RoomStatus.ENDED) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: 'Room not found or already ended.',
      });
    }
    return room;
  }

  async endRoom(roomId: string): Promise<void> {
    await this.prisma.room.update({
      where: { id: roomId },
      data: { status: RoomStatus.ENDED, isPlaying: false, endedAt: new Date() },
    });
    await this.redis.client.del(this.stateKey(roomId), this.membersKey(roomId));
  }

  // ---------- Authority (server-side, every control:* event) ----------
  async assertHost(roomId: string, userId: string): Promise<void> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { hostId: true, status: true },
    });
    if (!room || room.status === RoomStatus.ENDED) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: 'Room not found or already ended.',
      });
    }
    if (room.hostId !== userId) {
      throw new ForbiddenException({
        code: 'ROOM_NOT_HOST',
        message: 'Only the host can control playback.',
      });
    }
  }

  async isActiveMember(roomId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
      select: { leftAt: true },
    });
    return member !== null && member.leftAt === null;
  }

  async assertMember(roomId: string, userId: string): Promise<void> {
    if (!(await this.isActiveMember(roomId, userId))) {
      throw new ForbiddenException({
        code: 'ROOM_NOT_MEMBER',
        message: 'Join the room before doing that.',
      });
    }
  }

  // ---------- Membership ----------
  async join(roomId: string, userId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: { title: { select: { id: true, name: true, slug: true } } },
    });
    if (!room || room.status === RoomStatus.ENDED) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: 'Room not found or already ended.',
      });
    }

    const existing = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!existing) {
      const activeCount = await this.prisma.roomMember.count({
        where: { roomId, leftAt: null },
      });
      if (activeCount >= room.maxMembers) {
        throw new ForbiddenException({
          code: 'ROOM_FULL',
          message: 'This room is full.',
        });
      }
    }

    const member = await this.prisma.roomMember.upsert({
      where: { roomId_userId: { roomId, userId } },
      create: { roomId, userId },
      update: { leftAt: null },
      include: { user: { select: MEMBER_USER_SELECT } },
    });

    await this.redis.client.sadd(this.membersKey(roomId), userId);

    const [state, members] = await Promise.all([
      this.getState(roomId),
      this.activeMembers(roomId),
    ]);
    return { room, member, state, members };
  }

  async leave(roomId: string, userId: string): Promise<void> {
    await this.prisma.roomMember.updateMany({
      where: { roomId, userId, leftAt: null },
      data: { leftAt: new Date() },
    });
    await this.redis.client.srem(this.membersKey(roomId), userId);
  }

  activeMembers(roomId: string) {
    return this.prisma.roomMember.findMany({
      where: { roomId, leftAt: null },
      include: { user: { select: MEMBER_USER_SELECT } },
      orderBy: { joinedAt: 'asc' },
    });
  }

  async setMuted(
    roomId: string,
    targetUserId: string,
    muted: boolean,
  ): Promise<void> {
    const updated = await this.prisma.roomMember.updateMany({
      where: { roomId, userId: targetUserId, leftAt: null },
      data: { isMuted: muted },
    });
    if (updated.count === 0) {
      throw new NotFoundException({
        code: 'MEMBER_NOT_FOUND',
        message: 'That user is not in the room.',
      });
    }
  }

  // ---------- Playback state (control plane) ----------
  async getState(roomId: string): Promise<PlaybackState> {
    const cached = await this.redis.client.hgetall(this.stateKey(roomId));
    if (cached.positionSec !== undefined) {
      return {
        positionSec: Number(cached.positionSec),
        isPlaying: cached.isPlaying === '1',
        lastSyncAt: Number(cached.lastSyncAt),
      };
    }

    const room = await this.prisma.room.findUniqueOrThrow({
      where: { id: roomId },
      select: { positionSec: true, isPlaying: true, lastSyncAt: true },
    });
    const state: PlaybackState = {
      positionSec: room.positionSec,
      isPlaying: room.isPlaying,
      lastSyncAt: room.lastSyncAt.getTime(),
    };
    await this.writeStateToRedis(roomId, state);
    return state;
  }

  /**
   * Host play/pause/seek — updates Redis (hot path) and writes through to
   * Postgres. Heartbeats stay Redis-only (see `heartbeat`).
   */
  async setPlayback(
    roomId: string,
    positionSec: number,
    isPlaying: boolean,
  ): Promise<PlaybackState> {
    const state: PlaybackState = {
      positionSec,
      isPlaying,
      lastSyncAt: Date.now(),
    };
    await this.writeStateToRedis(roomId, state);
    await this.prisma.room.update({
      where: { id: roomId },
      data: {
        positionSec,
        isPlaying,
        lastSyncAt: new Date(state.lastSyncAt),
        status: isPlaying ? RoomStatus.PLAYING : RoomStatus.PAUSED,
      },
    });
    return state;
  }

  /** ~2s authoritative host tick — Redis only, Postgres is flushed on control events. */
  async heartbeat(roomId: string, positionSec: number): Promise<PlaybackState> {
    const cached = await this.getState(roomId);
    const state: PlaybackState = {
      positionSec,
      isPlaying: cached.isPlaying,
      lastSyncAt: Date.now(),
    };
    await this.writeStateToRedis(roomId, state);
    return state;
  }

  private async writeStateToRedis(
    roomId: string,
    state: PlaybackState,
  ): Promise<void> {
    await this.redis.client.hset(this.stateKey(roomId), {
      positionSec: state.positionSec,
      isPlaying: state.isPlaying ? '1' : '0',
      lastSyncAt: state.lastSyncAt,
    });
  }

  // ---------- Presence ----------
  async setPresence(
    userId: string,
    socketId: string,
    roomId: string,
  ): Promise<void> {
    await this.redis.client.set(
      this.presenceKey(userId),
      JSON.stringify({ socketId, roomId }),
      'EX',
      PRESENCE_TTL_SEC,
    );
  }

  async clearPresence(userId: string): Promise<void> {
    await this.redis.client.del(this.presenceKey(userId));
  }

  private generateCode(length = 6): string {
    const bytes = randomBytes(length);
    return Array.from(
      bytes,
      (b) => CODE_ALPHABET[b % CODE_ALPHABET.length],
    ).join('');
  }
}
