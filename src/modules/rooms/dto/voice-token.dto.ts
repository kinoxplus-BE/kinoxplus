import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Optional device hint attached to a voice-token request. Distinguishes the
 * caller as `mobile` (the RN app, the default) or `web` (the desktop escape
 * hatch used when DRM apps block mobile screen capture). Same user can hold
 * one connection of each kind in the same room without a LiveKit identity
 * collision.
 */
export class VoiceTokenRequestDto {
  @ApiPropertyOptional({
    enum: ['mobile', 'web'],
    default: 'mobile',
    description:
      'Which client is asking for the token. Defaults to `mobile` for backward compatibility with existing app builds.',
  })
  @IsOptional()
  @IsIn(['mobile', 'web'])
  device?: 'mobile' | 'web';
}
