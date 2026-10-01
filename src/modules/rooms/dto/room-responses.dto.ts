import { ApiProperty } from '@nestjs/swagger';

export class VoiceTokenLimitsDto {
  @ApiProperty({
    example: 1080,
    description:
      "Maximum video capture height the client should publish on this token (height in pixels). Clients must self-cap simulcast layers to respect the caller's plan — the server does not transcode.",
  })
  maxVideoHeight!: number;

  @ApiProperty({
    example: true,
    description:
      'Whether this plan allows HD screen share (1080p). Free tier publishes screen share at 720p; clients should pick the lower layer when this is false.',
  })
  canHDScreenShare!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 60,
    description:
      "Session cap in minutes for the room host, or null for unlimited. UI should surface a timer so users aren't surprised when the server ends the room.",
  })
  maxSessionMinutes!: number | null;
}

export class VoiceTokenResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Short-lived LiveKit access token scoped to this room.',
  })
  token!: string;

  @ApiProperty({
    example: 'kinoxplus-room-cmd9x0abc0000v0f4room1234',
    description: 'LiveKit room name derived from the KinoX room id.',
  })
  roomName!: string;

  @ApiProperty({
    example: 'wss://your-project.livekit.cloud',
    description:
      'LiveKit websocket URL the frontend should pass to the LiveKit client together with token.',
  })
  livekitUrl!: string;

  @ApiProperty({ type: VoiceTokenLimitsDto })
  limits!: VoiceTokenLimitsDto;
}
