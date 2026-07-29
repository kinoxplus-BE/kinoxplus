import { ApiProperty } from '@nestjs/swagger';

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
}
