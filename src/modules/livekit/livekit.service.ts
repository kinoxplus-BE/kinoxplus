import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';

/**
 * The client platform requesting a LiveKit token. One user can hold two
 * concurrent connections — for example, phone in voice + laptop presenting
 * screen — because each device gets a distinct LiveKit `identity`
 * (`userId#device`). Everything else — RoomMember, chat, invitations —
 * still keys on `userId`; only LiveKit needs to disambiguate.
 */
export type RoomDevice = 'mobile' | 'web';

/**
 * LiveKit identity for a token. When `device` is provided (post-pivot
 * clients), the identity is `userId#device` so the same user can join
 * from two devices at once without collision. When `device` is not
 * provided (pre-pivot mobile builds that predate the two-device support),
 * the identity is the bare `userId` — matching the shape those clients
 * expect to read from `participant.identity`.
 */
function identityFor(userId: string, device: RoomDevice | undefined): string {
  return device ? `${userId}#${device}` : userId;
}

/**
 * All possible identity shapes a user might currently be connected under.
 * Covers pre-pivot bare `userId` and post-pivot `userId#mobile` /
 * `userId#web`, so server-side moderation (mute, etc.) reaches every
 * device regardless of which token shape the client used.
 */
function allIdentitiesFor(userId: string): string[] {
  return [userId, `${userId}#mobile`, `${userId}#web`];
}

/**
 * True when a LiveKit server-SDK error is the expected "participant not
 * present in this room" case — safe to swallow. Everything else means a
 * real fault (auth, network, LiveKit outage) and must not be silenced.
 */
function isLivekitNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
  // Twirp errors from the server SDK carry a string code (e.g. "not_found").
  if (err.code === 'not_found') return true;
  // Some transports surface an HTTP status instead.
  if (err.status === 404) return true;
  // Belt-and-suspenders: any error whose message clearly names "not found".
  if (typeof err.message === 'string' && /not.?found/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Media plane (AGENTS.md §7). Backend mints short-lived, room-scoped tokens
 * that permit audio, video, and screen share. Mute is enforced server-side
 * via the LiveKit server SDK, never just a UI flag.
 */
@Injectable()
export class LivekitService {
  private readonly logger = new Logger(LivekitService.name);
  private readonly url?: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly roomService?: RoomServiceClient;

  constructor(config: ConfigService) {
    const url = config.get<string>('LIVEKIT_URL');
    this.url = url;
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
    return Boolean(this.url && this.apiKey && this.apiSecret);
  }

  get connectionUrl(): string {
    if (!this.url) {
      throw new ServiceUnavailableException({
        code: 'LIVEKIT_NOT_CONFIGURED',
        message: 'Voice is not available right now.',
      });
    }
    return this.url;
  }

  roomName(roomId: string): string {
    return `kinoxplus-room-${roomId}`;
  }

  /**
   * Mints a room-scoped access token. When `device` is passed (post-pivot
   * mobile builds and the web client), the identity carries a device suffix
   * so the same user can hold a mobile and a web connection concurrently.
   * When `device` is omitted (existing app builds that shipped before the
   * pivot), the identity is a bare `userId` — same shape those builds are
   * already parsing on the client side.
   */
  async mintToken(
    roomId: string,
    userId: string,
    isHost: boolean,
    device?: RoomDevice,
  ): Promise<string> {
    if (!this.isConfigured || !this.apiKey || !this.apiSecret) {
      throw new ServiceUnavailableException({
        code: 'LIVEKIT_NOT_CONFIGURED',
        message: 'Voice is not available right now.',
      });
    }
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: identityFor(userId, device),
      ttl: '2h',
    });
    token.addGrant({
      roomJoin: true,
      room: this.roomName(roomId),
      canPublish: true,
      // Explicitly whitelist every media source. `canPublish: true` alone
      // permits all sources per the docs, but some client-side integrations
      // read `canPublishSources` directly and refuse to publish a track type
      // that isn't listed — belt-and-suspenders.
      canPublishSources: [
        TrackSource.MICROPHONE,
        TrackSource.CAMERA,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ],
      canSubscribe: true,
      // Data channel — needed for track metadata sync in some LiveKit
      // client SDKs (they use it for aspect-ratio / camera-facing hints).
      canPublishData: true,
      // Lets participants flip their own "camera on/off" metadata so the
      // rest of the room can render a proper offline avatar when off.
      canUpdateOwnMetadata: true,
      roomAdmin: isHost,
    });
    return token.toJwt();
  }

  /**
   * Server-authoritative mute of a user's published audio tracks. Applied
   * across every device the user has connected — muting on mobile alone
   * would leave a laptop mic hot for a hybrid session.
   */
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
    await Promise.all(
      allIdentitiesFor(userId).map((identity) =>
        this.muteIdentityAudio(room, identity, muted),
      ),
    );
  }

  /**
   * Mute every audio track for one specific device-identity. A "participant
   * not found" from LiveKit is expected whenever the user hasn't connected
   * that device — swallowed silently. Every other failure (network, auth,
   * LiveKit outage) is logged, because a silent mute failure means a
   * moderator thinks they've silenced someone but the mic is still hot.
   */
  private async muteIdentityAudio(
    room: string,
    identity: string,
    muted: boolean,
  ): Promise<void> {
    if (!this.roomService) return;
    try {
      const participant = await this.roomService.getParticipant(room, identity);
      await Promise.all(
        participant.tracks
          .filter((track) => track.type === TrackType.AUDIO)
          .map((track) =>
            this.roomService!.mutePublishedTrack(
              room,
              identity,
              track.sid,
              muted,
            ),
          ),
      );
    } catch (error) {
      if (isLivekitNotFoundError(error)) {
        // Common path — this identity isn't connected right now.
        return;
      }
      this.logger.warn(
        `LiveKit mute failed for ${identity} in ${room}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export { identityFor, allIdentitiesFor };
