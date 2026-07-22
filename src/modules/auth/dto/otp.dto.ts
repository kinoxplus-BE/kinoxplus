import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Length, MinLength } from 'class-validator';

// Purposes accepted by POST /auth/otp/request. All are public because a user
// can legitimately need any of these before being signed in.
//   signup: pre-registration email verification (no account yet) — verifyOtp
//           issues a signupToken consumed by POST /auth/register.
//   login:  passwordless login — verifyOtp returns a token pair.
//   verify: post-registration email/phone verification. verifyOtp does NOT
//           accept this; use the authenticated POST /auth/verify-email instead
//           so only the account owner can flip verification.
//   reset:  password reset — verifyOtp returns a resetToken for /reset-password.
const REQUEST_OTP_PURPOSES = ['signup', 'login', 'verify', 'reset'] as const;
export type OtpPurpose = (typeof REQUEST_OTP_PURPOSES)[number];

// verify is excluded — verification must go through POST /auth/verify-email
// (bearer required) so someone with a leaked OTP can't flip verification on
// another user's account.
const VERIFY_OTP_PURPOSES = ['signup', 'login', 'reset'] as const;
export type VerifiableOtpPurpose = (typeof VERIFY_OTP_PURPOSES)[number];

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase().trim() : value;

export class RequestOtpDto {
  @ApiProperty({
    example: 'john@example.com',
    description: 'Email address or E.164 phone number',
  })
  @Transform(lowercaseTrim)
  @IsString()
  @MinLength(3)
  identifier!: string;

  @ApiProperty({ enum: REQUEST_OTP_PURPOSES, example: 'signup' })
  @IsIn(REQUEST_OTP_PURPOSES)
  purpose!: OtpPurpose;
}

export class VerifyOtpDto {
  @ApiProperty({
    example: 'john@example.com',
    description: 'Same identifier used in request',
  })
  @Transform(lowercaseTrim)
  @IsString()
  @MinLength(3)
  identifier!: string;

  @ApiProperty({ example: '482917', description: '6-digit OTP code' })
  @IsString()
  @Length(6, 6)
  code!: string;

  @ApiProperty({
    enum: VERIFY_OTP_PURPOSES,
    example: 'signup',
    description:
      'For "verify" purpose (post-registration email verification), use POST /auth/verify-email — it requires authentication.',
  })
  @IsIn(VERIFY_OTP_PURPOSES)
  purpose!: VerifiableOtpPurpose;
}

/** POST /auth/verify-email — bearer required. */
export class VerifyEmailDto {
  @ApiProperty({ example: '482917', description: '6-digit OTP code' })
  @IsString()
  @Length(6, 6)
  code!: string;
}
