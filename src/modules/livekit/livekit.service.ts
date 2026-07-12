import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient, TrackType } from 'livekit-server-sdk';

/**
 * Voice plane (AGENTS.md §7). Backend mints short-lived, room-scoped tokens;
 * mute is enforced server-side via the LiveKit server SDK, never just a UI flag.
 * [POST-MVP] video calling reuses the same rooms — enable video tracks.
 */
@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly roomService?: RoomServiceClient;

  constructor(config: ConfigService) {
    const url = config.get<string>('LIVEKIT_URL');
    this.apiKey = config.get<string>('LIVEKIT_API_KEY');
    this.apiSecret = config.get<string>('LIVEKIT_API_SECRET');

    if (url && this.apiKey && this.apiSecret) {
      const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
      this.roomService = new RoomServiceClient(
        httpUrl,
        this.apiKey,
        this.apiSecret,
      );
    } else {
      this.logger.warn('LiveKit env vars not set — voice plane disabled.');
    }
  }

  get isConfigured(): boolean {
    return this.roomService !== undefined;
  }

  roomName(roomId: string): string {
    return `graflix-room-${roomId}`;
  }

  async mintToken(
    roomId: string,
    userId: string,
    isHost: boolean,
  ): Promise<string> {
    if (!this.apiKey || !this.apiSecret) {
      throw new ServiceUnavailableException({
        code: 'LIVEKIT_NOT_CONFIGURED',
        message: 'Voice is not available right now.',
      });
    }
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: userId,
      ttl: '2h',
    });
    token.addGrant({
      roomJoin: true,
      room: this.roomName(roomId),
      canPublish: true,
      canSubscribe: true,
      roomAdmin: isHost,
    });
    return token.toJwt();
  }

  /** Server-authoritative mute of a member's published audio tracks. */
  async setParticipantMuted(
    roomId: string,
    userId: string,
    muted: boolean,
  ): Promise<void> {
    if (!this.roomService) {
      // DB flag is still set; voice enforcement resumes once LiveKit is configured.
      this.logger.warn(`Skipping LiveKit mute for ${userId} — not configured.`);
      return;
    }
    const room = this.roomName(roomId);
    try {
      const participant = await this.roomService.getParticipant(room, userId);
      await Promise.all(
        participant.tracks
          .filter((track) => track.type === TrackType.AUDIO)
          .map((track) =>
            this.roomService!.mutePublishedTrack(
              room,
              userId,
              track.sid,
              muted,
            ),
          ),
      );
    } catch (error) {
      // Participant may not have joined voice yet — the DB flag applies on join.
      this.logger.warn(
        `LiveKit mute failed for ${userId} in ${room}: ${String(error)}`,
      );
    }
  }
}
