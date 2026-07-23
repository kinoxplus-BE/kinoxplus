import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, MaxLength, MinLength } from 'class-validator';
import { DeviceInfoDto, DeviceInfoField } from './device-info.dto';

/** Verify the first TOTP code and commit 2FA on the account. */
export class EnableTwoFactorDto {
  @ApiProperty({
    example: '482917',
    description: 'The 6-digit TOTP code from your authenticator app',
  })
  @IsString()
  @Length(6, 6)
  code!: string;
}

/** Turning off 2FA requires the current password + a valid TOTP code —
 * defense in depth against someone with only the password. */
export class DisableTwoFactorDto {
  @ApiProperty({ example: 'correct horse battery' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({
    example: '482917',
    description: '6-digit TOTP code (or an 8-char backup code)',
  })
  @IsString()
  @MinLength(6)
  @MaxLength(12)
  code!: string;
}

/** Complete the 2FA-gated login. */
export class TwoFactorChallengeDto {
  @ApiProperty({
    description: 'The single-use challengeToken returned from POST /auth/login',
    example: '3f1c8a2d5e9b0f47c6a1d8e3b5f2a9c04d7e1b8f5a2c9e6b3d0f7a4c1e8b5d2a',
  })
  @IsString()
  @Length(64, 64)
  challengeToken!: string;

  @ApiProperty({
    description: '6-digit TOTP code, OR one of the 8-char backup codes',
    example: '482917',
  })
  @IsString()
  @MinLength(6)
  @MaxLength(12)
  code!: string;

  @DeviceInfoField()
  device?: DeviceInfoDto;
}
