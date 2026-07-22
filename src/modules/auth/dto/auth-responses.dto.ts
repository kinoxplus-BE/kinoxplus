import { ApiProperty } from '@nestjs/swagger';
import { Role } from '../../../generated/prisma/client';

/**
 * Response models for the auth endpoints. Purely documentation: services
 * return plain objects with these exact shapes, and TransformInterceptor
 * wraps them in { success, data, meta } (see ApiEnvelope).
 */

export class AuthUserDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4ghij1234' })
  id!: string;

  @ApiProperty({ enum: Role, example: Role.USER })
  role!: Role;

  @ApiProperty({ example: 'ada@example.com', nullable: true, type: String })
  email!: string | null;

  @ApiProperty({
    example: 'priyan',
    nullable: true,
    type: String,
    description: 'Handle shown to friends in rooms (lowercase)',
  })
  username!: string | null;

  @ApiProperty({ example: 'Ada Lovelace', description: 'Full name' })
  displayName!: string;

  @ApiProperty({
    example: 'https://res.cloudinary.com/kinoxplus/…/avatar.jpg',
    nullable: true,
    type: String,
    description: 'Cloudinary URL; null until the user uploads an avatar.',
  })
  avatarUrl!: string | null;

  @ApiProperty({
    example: '#3652D9',
    nullable: true,
    type: String,
    description: 'Swatch color used as placeholder while avatarUrl is null.',
  })
  avatarColor!: string | null;

  @ApiProperty({
    example: false,
    description: 'False until the signup OTP is verified',
  })
  emailVerified!: boolean;
}

export class UsernameAvailabilityDto {
  @ApiProperty({ example: true })
  available!: boolean;
}

export class TokenPairDto {
  @ApiProperty({
    description: 'JWT. Send as "Authorization: Bearer <accessToken>".',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbWQ5eDBh…',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Opaque rotating token for POST /auth/refresh. Single use — each refresh returns a new one. Store securely (Keychain/Keystore), never in plain storage.',
    example: '9f2dc1a4e8b7360d5f4a2c9e1b8d7f60a3c5e9b1d4f7a0c2e5b8d1f4a7c0e3b6',
  })
  refreshToken!: string;
}

export class AuthSessionDto extends TokenPairDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Logged out successfully.' })
  message!: string;
}

export class OtpRequestedDto {
  @ApiProperty({
    example: 'If an account exists for john@example.com, a code has been sent.',
  })
  message!: string;

  @ApiProperty({ description: 'OTP validity in seconds', example: 600 })
  expiresIn!: number;
}

/** verifyOtp result for purpose "verify". */
export class OtpVerifiedDto {
  @ApiProperty({ example: true })
  verified!: boolean;
}

/** verifyOtp result for purpose "signup" (pre-registration). */
export class SignupTokenDto {
  @ApiProperty({ example: true })
  verified!: boolean;

  @ApiProperty({
    description:
      'Single-use token to include in POST /auth/register as signupToken. Complete the profile step within its validity window.',
    example: '3f1c8a2d5e9b0f47c6a1d8e3b5f2a9c04d7e1b8f5a2c9e6b3d0f7a4c1e8b5d2a',
  })
  signupToken!: string;

  @ApiProperty({
    description: 'Signup token validity in seconds',
    example: 1800,
  })
  expiresIn!: number;
}

/** verifyOtp result for purpose "reset". */
export class ResetTokenDto {
  @ApiProperty({ example: true })
  verified!: boolean;

  @ApiProperty({
    description:
      'Single-use token to pass to POST /auth/reset-password instead of the OTP code.',
    example: '3f1c8a2d5e9b0f47c6a1d8e3b5f2a9c04d7e1b8f5a2c9e6b3d0f7a4c1e8b5d2a',
  })
  resetToken!: string;

  @ApiProperty({ description: 'Reset token validity in seconds', example: 900 })
  expiresIn!: number;
}

export class PasswordChangedDto extends TokenPairDto {
  @ApiProperty({
    example: 'Password changed. All other sessions were signed out.',
  })
  message!: string;
}
