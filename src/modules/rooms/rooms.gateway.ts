import { Logger, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { WsAllExceptionsFilter } from '../../common/filters/ws-exceptions.filter';
import type { JwtPayload } from '../../common/types';
import { ChatService } from '../chat/chat.service';
import { LivekitService } from '../livekit/livekit.service';
import { StreamingService } from '../streaming/streaming.service';
import {
  ChangeTitleDto,
  ChatSendDto,
  ControlDto,
  HeartbeatDto,
  JoinRoomDto,
  KickMemberDto,
  MuteDto,
  RoomRefDto,
  TransferHostDto,
} from './dto/room-events.dto';
import {
  ROOM_MEMBER_FORCE_LEFT_EVENT,
  type RoomMemberForceLeftEvent,
} from './rooms.events';
import { RoomsService } from './rooms.service';

interface RoomSocket extends Socket {
  data: { userId: string };
}

// Minimum ms between two `sync:state` broadcasts triggered by heartbeat
// for the same room. Client-driven control:play/pause/seek still fires
// immediately — this only rate-limits the periodic drift-correction ticks.
const HEARTBEAT_BROADCAST_MIN_MS = 4000;

/**
 * ⭐ Watch Room control plane (AGENTS.md §6).
 * Playback (HLS) never touches this layer; voice rides LiveKit. This gateway
 * carries only tiny control/chat messages, fanned out across instances by the
 * Redis adapter. Host authority is asserted server-side on every control:*.
 */
@UseFilters(WsAllExceptionsFilter)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
@WebSocketGateway({ namespace: '/rooms', cors: true })
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RoomsGateway.name);
  // In-memory throttle map — roomId → last-broadcast timestamp (ms).
  // Bounded by the number of concurrently active rooms; endRoom prunes.
  // Not persisted across instances: worst case, briefly higher broadcast
  // rate right after a rolling deploy. Acceptable for a drift tick.
  private readonly lastHeartbeatBroadcast = new Map<string, number>();

  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly rooms: RoomsService,
    private readonly chat: ChatService,
    private readonly livekit: LivekitService,
    private readonly jwt: JwtService,
    private readonly streaming: StreamingService,
  ) {}

  // ---------- Connection auth: JWT in handshake.auth.token ----------
  async handleConnection(client: RoomSocket): Promise<void> {
    try {
      const token = (client.handshake.auth as Record<string, unknown>).token;
      if (typeof token !== 'string') throw new Error('missing token');
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      client.data.userId = payload.sub;
    } catch {
      client.emit('error', {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing token.',
      });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: RoomSocket): Promise<void> {
    const userId = client.data.userId;
    if (!userId) return;
    // Tell whichever room this socket was in that the member went offline.
    // They're still a member (leftAt still null) — just not connected.
    const roomId = await this.rooms.getPresenceRoomId(userId);
    await this.rooms.clearPresence(userId);
    if (roomId) {
      this.server.to(roomId).emit('member:offline', { userId });
    }
  }

  // ---------- Membership ----------
  @SubscribeMessage('room:join')
  async onJoin(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: JoinRoomDto,
  ) {
    const userId = client.data.userId;
    const { room, member, state, members } = await this.rooms.join(
      dto.roomId,
      userId,
      dto.code,
      { force: dto.force },
    );

    await client.join(dto.roomId);
    await this.rooms.setPresence(userId, client.id, dto.roomId);

    // Delta event for animations / toasts.
    client.to(dto.roomId).emit('member:joined', { user: member.user });
    // Authoritative snapshot — self-healing so any client that missed
    // the delta (or has a stale local list) reconciles automatically.
    // Fires to EVERYONE in the room including the joiner, so both the
    // joiner's ack handler and their snapshot handler agree.
    await this.broadcastMembersSnapshot(dto.roomId);

    // Fire `sync:state` directly to the joining socket. This hits the
    // client's normal drift-correction handler (the one wired for
    // periodic sync ticks), guaranteeing the video seeks to the host's
    // current position without racing with the HLS player's own
    // resume-from-cached-position behavior. Fixes the "rejoin resumes
    // at old position" bug without any client contract change.
    client.emit('sync:state', {
      ...state,
      serverTs: Date.now(),
      /** True on initial join / rejoin — clients can force-seek even
       *  if their local position looks close to authoritative. */
      authoritative: true,
    });

    // Resolve the playback URL inline so the client can start fetching
    // the HLS manifest immediately — saves the extra REST round trip
    // that used to sit between "I know the movie" and "I have the URL
    // to feed the player". On slow networks that's 500ms-2s of wall time.
    const playback = room.title?.id
      ? await this.streaming.safeResolvePlayback(room.title.id)
      : null;

    // Late joiners receive the authoritative state and seek to it.
    return {
      room,
      state: { ...state, serverTs: Date.now() },
      members,
      playback,
    };
  }

  @SubscribeMessage('room:leave')
  async onLeave(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: RoomRefDto,
  ) {
    const userId = client.data.userId;
    await this.rooms.leave(dto.roomId, userId);
    await client.leave(dto.roomId);
    await this.rooms.clearPresence(userId);
    this.server.to(dto.roomId).emit('member:left', { userId });
    await this.broadcastMembersSnapshot(dto.roomId);
    return { left: true };
  }

  @OnEvent(ROOM_MEMBER_FORCE_LEFT_EVENT)
  async onMemberForceLeft(event: RoomMemberForceLeftEvent): Promise<void> {
    try {
      this.server.to(event.roomId).emit('member:left', {
        userId: event.userId,
      });
      await this.broadcastMembersSnapshot(event.roomId);

      const socketId = await this.rooms.getPresenceSocketId(event.userId);
      if (socketId) {
        // socketsLeave is fire-and-forget on the local namespace + adapter.
        this.server.in(socketId).socketsLeave(event.roomId);
      }

      const currentPresenceRoomId = await this.rooms.getPresenceRoomId(
        event.userId,
      );
      if (currentPresenceRoomId === event.roomId) {
        await this.rooms.clearPresence(event.userId);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to broadcast force-leave for ${event.userId} in ${event.roomId}: ${String(error)}`,
      );
    }
  }

  // ---------- Control plane (host only — asserted server-side) ----------
  @SubscribeMessage('control:play')
  async onPlay(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: ControlDto,
  ) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    const state = await this.rooms.setPlayback(
      dto.roomId,
      dto.positionSec,
      true,
    );
    this.broadcastState(dto.roomId, state);
  }

  @SubscribeMessage('control:pause')
  async onPause(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: ControlDto,
  ) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    const state = await this.rooms.setPlayback(
      dto.roomId,
      dto.positionSec,
      false,
    );
    this.broadcastState(dto.roomId, state);
  }

  @SubscribeMessage('control:seek')
  async onSeek(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: ControlDto,
  ) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    const current = await this.rooms.getState(dto.roomId);
    const state = await this.rooms.setPlayback(
      dto.roomId,
      dto.positionSec,
      current.isPlaying,
    );
    this.broadcastState(dto.roomId, state);
  }

  /**
   * Authoritative host tick — client sends every ~2s to correct drift.
   *
   * Redis is always updated (cheap). The fanout `sync:state` broadcast is
   * throttled server-side to at most one per HEARTBEAT_BROADCAST_MIN_MS per
   * room, and skipped entirely when playback is paused (nothing to sync).
   * This is the single biggest win for slow-network members — cuts state
   * frames by ~50% without changing the client contract or losing sync
   * quality on the happy path (real drift corrections still fire on
   * control:play / pause / seek immediately).
   */
  @SubscribeMessage('control:heartbeat')
  async onHeartbeat(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: HeartbeatDto,
  ) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    const state = await this.rooms.heartbeat(dto.roomId, dto.positionSec);

    if (!state.isPlaying) return; // paused → no sync needed

    const now = Date.now();
    const last = this.lastHeartbeatBroadcast.get(dto.roomId) ?? 0;
    if (now - last < HEARTBEAT_BROADCAST_MIN_MS) return;

    this.lastHeartbeatBroadcast.set(dto.roomId, now);
    this.broadcastState(dto.roomId, state);
  }

  // ---------- Chat ----------
  @SubscribeMessage('chat:send')
  async onChatSend(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: ChatSendDto,
  ) {
    const userId = client.data.userId;
    await this.rooms.assertMember(dto.roomId, userId);
    const message = await this.chat.addMessage(dto.roomId, userId, dto.body);
    this.server.to(dto.roomId).emit('chat:message', {
      id: message.id,
      user: message.user,
      body: message.body,
      createdAt: message.createdAt,
    });
  }

  // ---------- Moderation ----------
  @SubscribeMessage('member:mute')
  async onMute(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: MuteDto,
  ) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    await this.rooms.setMuted(dto.roomId, dto.targetUserId, dto.muted);
    await this.livekit.setParticipantMuted(
      dto.roomId,
      dto.targetUserId,
      dto.muted,
    );
    this.server.to(dto.roomId).emit('member:updated', {
      userId: dto.targetUserId,
      isMuted: dto.muted,
    });
  }

  @SubscribeMessage('room:end')
  async onEnd(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: RoomRefDto,
  ) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    await this.rooms.endRoom(dto.roomId);
    this.lastHeartbeatBroadcast.delete(dto.roomId);
    this.server.to(dto.roomId).emit('room:ended', { roomId: dto.roomId });
    this.server.in(dto.roomId).socketsLeave(dto.roomId);
  }

  /** Host kicks a specific member. Target's socket is evicted immediately. */
  @SubscribeMessage('member:kick')
  async onKick(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: KickMemberDto,
  ) {
    await this.rooms.kickMember(
      dto.roomId,
      client.data.userId,
      dto.targetUserId,
    );
    // Tell the room + tell the target directly, then evict their sockets.
    this.server
      .to(dto.roomId)
      .emit('member:kicked', { userId: dto.targetUserId });
    const targetSocketId = await this.rooms.getPresenceSocketId(
      dto.targetUserId,
    );
    if (targetSocketId) {
      const targetSocket = this.server.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit('you:kicked', { roomId: dto.roomId });
        await targetSocket.leave(dto.roomId);
      }
    }
    await this.rooms.clearPresence(dto.targetUserId);
    await this.broadcastMembersSnapshot(dto.roomId);
  }

  /** Host mutes every non-host member at once. */
  @SubscribeMessage('member:mute-all')
  async onMuteAll(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: RoomRefDto,
  ) {
    const muted = await this.rooms.muteAll(dto.roomId, client.data.userId);
    await Promise.all(
      muted.map((userId) =>
        this.livekit.setParticipantMuted(dto.roomId, userId, true),
      ),
    );
    for (const userId of muted) {
      this.server
        .to(dto.roomId)
        .emit('member:updated', { userId, isMuted: true });
    }
    return { muted: muted.length };
  }

  /** Host transfers ownership to another active member. */
  @SubscribeMessage('host:transfer')
  async onTransferHost(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: TransferHostDto,
  ) {
    const result = await this.rooms.transferHost(
      dto.roomId,
      client.data.userId,
      dto.targetUserId,
    );
    this.server.to(dto.roomId).emit('host:transferred', result);
    return result;
  }

  // ---------- Current title (movie in the room) ----------

  /** Host picks a new movie OR swaps the current one mid-session. Playback
   *  resets to 0 for everyone — the gateway broadcasts both the new title
   *  and the reset state so clients can jump to it. */
  @SubscribeMessage('title:change')
  async onTitleChange(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: ChangeTitleDto,
  ) {
    const { room, state } = await this.rooms.changeTitle(
      dto.roomId,
      client.data.userId,
      dto.titleId,
    );
    // Resolve the URL in parallel with the broadcast so the wire delivery
    // starts as soon as either promise settles. On slow networks the
    // client can start prefetching HLS as soon as this arrives instead
    // of firing a separate GET /streaming/titles/:id/playback afterward.
    const playback = room.title?.id
      ? await this.streaming.safeResolvePlayback(room.title.id)
      : null;
    const payload = {
      title: room.title,
      state: { ...state, serverTs: Date.now() },
      playback,
    };
    this.server.to(dto.roomId).emit('title:changed', payload);
    return payload;
  }

  /** Host drops the current movie back to lobby mode — chat/voice/video
   *  keep running, but there's no playback until they pick a new title. */
  @SubscribeMessage('title:clear')
  async onTitleClear(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: RoomRefDto,
  ) {
    const { state } = await this.rooms.clearTitle(
      dto.roomId,
      client.data.userId,
    );
    const payload = {
      title: null,
      state: { ...state, serverTs: Date.now() },
      playback: null,
    };
    this.server.to(dto.roomId).emit('title:changed', payload);
    return payload;
  }

  private broadcastState(
    roomId: string,
    state: { positionSec: number; isPlaying: boolean },
  ): void {
    this.server.to(roomId).emit('sync:state', {
      positionSec: state.positionSec,
      isPlaying: state.isPlaying,
      serverTs: Date.now(),
    });
  }

  /**
   * Broadcast the AUTHORITATIVE full members list to the room. Self-healing —
   * clients that missed a `member:joined` / `member:left` delta (network
   * hiccup, event-ordering race, buggy merge logic) reconcile on the next
   * membership change. Small payload (<= 20 members × ~50 bytes = 1KB) even
   * without compression; ships in a single gzipped frame after compression.
   */
  private async broadcastMembersSnapshot(roomId: string): Promise<void> {
    try {
      const members = await this.rooms.activeMembers(roomId);
      this.server.to(roomId).emit('members:snapshot', { members });
    } catch (err) {
      // Never fail the caller's request on snapshot broadcast failure —
      // delta events already fired and the next membership change will
      // re-broadcast the snapshot anyway.
      this.logger.warn(
        `members:snapshot broadcast failed for ${roomId}: ${String(err)}`,
      );
    }
  }
}
