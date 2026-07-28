import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  InvitationStatus,
  RoomStatus,
  TitleStatus,
} from '../../generated/prisma/client';
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
    opts: { isPrivate?: boolean; maxMembers?: number; force?: boolean } = {},
  ) {
    // Enforcement: one active room per user (host or member). Without
    // `force`, we return 409 with the current room's info so the client
    // can prompt "Leave [current] and create new?". With `force=true`,
    // we auto-leave every other room first.
    await this.enforceSingleRoomOrLeaveOthers(hostId, undefined, opts.force);

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

  /**
   * Auto-consumed by createRoom and join. If the user is already an active
   * member of another (non-ended) room:
   *  - `force=true` → mark them left in every other room (no error)
   *  - otherwise    → 409 ALREADY_IN_ROOM with { currentRoomId, currentRoomCode }
   */
  private async enforceSingleRoomOrLeaveOthers(
    userId: string,
    excludeRoomId: string | undefined,
    force: boolean | undefined,
  ): Promise<void> {
    const others = await this.prisma.roomMember.findMany({
      where: {
        userId,
        leftAt: null,
        ...(excludeRoomId ? { roomId: { not: excludeRoomId } } : {}),
        room: { status: { not: RoomStatus.ENDED } },
      },
      select: {
        roomId: true,
        room: { select: { id: true, code: true } },
      },
    });
    if (others.length === 0) return;

    if (!force) {
      const current = others[0].room;
      throw new ConflictException({
        code: 'ALREADY_IN_ROOM',
        message: `You're already in a room (${current.code}). Leave it first or pass force=true to auto-leave.`,
        currentRoomId: current.id,
        currentRoomCode: current.code,
      });
    }

    // Force-leave every other room.
    for (const other of others) {
      await this.leave(other.roomId, userId);
    }
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
    await this.prisma.$transaction([
      this.prisma.room.update({
        where: { id: roomId },
        data: {
          status: RoomStatus.ENDED,
          isPlaying: false,
          endedAt: new Date(),
        },
      }),
      // Any pending invitation for a room that's now over should stop
      // showing up on invitees' dashboards.
      this.prisma.roomInvitation.updateMany({
        where: { roomId, status: InvitationStatus.PENDING },
        data: { status: InvitationStatus.EXPIRED },
      }),
    ]);
    await this.redis.client.del(this.stateKey(roomId), this.membersKey(roomId));
  }

  // ---------- Host actions: kick, mute-all, transfer ownership ----------

  /**
   * Host kicks a member. Marks them left in the DB, removes from Redis
   * member set. The gateway is responsible for evicting the target's socket
   * from the Socket.io room and emitting `you:kicked` to them.
   */
  async kickMember(
    roomId: string,
    hostId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.assertHost(roomId, hostId);
    if (targetUserId === hostId) {
      throw new BadRequestException({
        code: 'CANNOT_KICK_HOST',
        message: 'Transfer host to someone else before leaving.',
      });
    }
    const result = await this.prisma.roomMember.updateMany({
      where: { roomId, userId: targetUserId, leftAt: null },
      data: { leftAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException({
        code: 'MEMBER_NOT_FOUND',
        message: 'That user is not in the room.',
      });
    }
    await this.redis.client.srem(this.membersKey(roomId), targetUserId);
  }

  /**
   * Host bulk-mutes every non-host member. Returns the list of muted userIds
   * so the gateway can emit `member:updated` for each + call LiveKit mute.
   */
  async muteAll(roomId: string, hostId: string): Promise<string[]> {
    await this.assertHost(roomId, hostId);
    const targets = await this.prisma.roomMember.findMany({
      where: {
        roomId,
        leftAt: null,
        userId: { not: hostId },
        isMuted: false,
      },
      select: { userId: true },
    });
    if (targets.length === 0) return [];
    await this.prisma.roomMember.updateMany({
      where: {
        roomId,
        userId: { in: targets.map((t) => t.userId) },
        leftAt: null,
      },
      data: { isMuted: true },
    });
    return targets.map((t) => t.userId);
  }

  /**
   * Transfer host to another active member. Atomic — old host stays as a
   * regular member on the same row. There is always exactly one host.
   */
  async transferHost(
    roomId: string,
    currentHostId: string,
    newHostUserId: string,
  ): Promise<{ oldHostId: string; newHostId: string }> {
    await this.assertHost(roomId, currentHostId);
    if (newHostUserId === currentHostId) {
      throw new BadRequestException({
        code: 'ALREADY_HOST',
        message: 'You are already the host.',
      });
    }
    // Target must be an active member of THIS room.
    const target = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: newHostUserId } },
      select: { leftAt: true },
    });
    if (!target || target.leftAt !== null) {
      throw new BadRequestException({
        code: 'MEMBER_NOT_FOUND',
        message: 'The new host must be an active member of the room.',
      });
    }
    await this.prisma.room.update({
      where: { id: roomId },
      data: { hostId: newHostUserId },
    });
    return { oldHostId: currentHostId, newHostId: newHostUserId };
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
  async join(
    roomId: string,
    userId: string,
    inviteCode?: string,
    opts: { force?: boolean } = {},
  ) {
    // Users can only be in one active room at a time.
    await this.enforceSingleRoomOrLeaveOthers(userId, roomId, opts.force);

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
    const needsSeat = !existing || existing.leftAt !== null;

    if (room.isPrivate && room.hostId !== userId && needsSeat) {
      // Accept either the invite code OR a pending invitation for this user.
      const hasInvitation = await this.hasPendingInvitationFor(roomId, userId);
      const normalizedInviteCode = inviteCode?.trim().toUpperCase();
      const codeValid =
        normalizedInviteCode !== undefined &&
        normalizedInviteCode === room.code;
      if (!hasInvitation && !codeValid) {
        throw new ForbiddenException({
          code: 'ROOM_INVITE_REQUIRED',
          message:
            'This room is private. Use the invite code or accept an invitation.',
        });
      }
    }

    if (needsSeat) {
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

    // Mark any pending invitation for this user + room as accepted so it
    // stops appearing on their dashboard.
    await this.prisma.roomInvitation.updateMany({
      where: {
        roomId,
        invitedUserId: userId,
        status: InvitationStatus.PENDING,
      },
      data: { status: InvitationStatus.ACCEPTED },
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

  /** Which room, if any, is this user currently sitting in. */
  async getPresenceRoomId(userId: string): Promise<string | null> {
    const raw = await this.redis.client.get(this.presenceKey(userId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { roomId?: string };
      return typeof parsed.roomId === 'string' ? parsed.roomId : null;
    } catch {
      return null;
    }
  }

  async getPresenceSocketId(userId: string): Promise<string | null> {
    const raw = await this.redis.client.get(this.presenceKey(userId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { socketId?: string };
      return typeof parsed.socketId === 'string' ? parsed.socketId : null;
    } catch {
      return null;
    }
  }

  private async hasPendingInvitationFor(
    roomId: string,
    userId: string,
  ): Promise<boolean> {
    const invitation = await this.prisma.roomInvitation.findFirst({
      where: {
        roomId,
        invitedUserId: userId,
        status: InvitationStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return invitation !== null;
  }

  private generateCode(length = 6): string {
    const bytes = randomBytes(length);
    return Array.from(
      bytes,
      (b) => CODE_ALPHABET[b % CODE_ALPHABET.length],
    ).join('');
  }
}
