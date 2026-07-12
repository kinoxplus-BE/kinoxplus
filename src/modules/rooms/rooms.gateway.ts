import { UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
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
import {
  ChatSendDto,
  ControlDto,
  HeartbeatDto,
  MuteDto,
  RoomRefDto,
} from './dto/room-events.dto';
import { RoomsService } from './rooms.service';

interface RoomSocket extends Socket {
  data: { userId: string };
}

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
  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly rooms: RoomsService,
    private readonly chat: ChatService,
    private readonly livekit: LivekitService,
    private readonly jwt: JwtService,
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
    if (client.data.userId) {
      await this.rooms.clearPresence(client.data.userId);
    }
  }

  // ---------- Membership ----------
  @SubscribeMessage('room:join')
  async onJoin(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: RoomRefDto,
  ) {
    const userId = client.data.userId;
    const { room, member, state, members } = await this.rooms.join(
      dto.roomId,
      userId,
    );

    await client.join(dto.roomId);
    await this.rooms.setPresence(userId, client.id, dto.roomId);

    client.to(dto.roomId).emit('member:joined', { user: member.user });

    // Late joiners receive the authoritative state and seek to it.
    return { room, state: { ...state, serverTs: Date.now() }, members };
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
    return { left: true };
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

  /** Authoritative host tick (~2s) to correct drift. Redis-only write. */
  @SubscribeMessage('control:heartbeat')
  async onHeartbeat(
    @ConnectedSocket() client: RoomSocket,
    @MessageBody() dto: HeartbeatDto,
  ) {
    await this.rooms.assertHost(dto.roomId, client.data.userId);
    const state = await this.rooms.heartbeat(dto.roomId, dto.positionSec);
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
    this.server.to(dto.roomId).emit('room:ended', { roomId: dto.roomId });
    this.server.in(dto.roomId).socketsLeave(dto.roomId);
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
}
