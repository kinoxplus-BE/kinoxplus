import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Length, MinLength } from 'class-validator';

// signup: pre-registration email verification (no account yet) — issues a
// signupToken consumed by POST /auth/register.
const OTP_PURPOSES = ['signup', 'login', 'verify', 'reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

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

  @ApiProperty({ enum: OTP_PURPOSES, example: 'verify' })
  @IsIn(OTP_PURPOSES)
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

  @ApiProperty({ enum: OTP_PURPOSES, example: 'verify' })
  @IsIn(OTP_PURPOSES)
  purpose!: OtpPurpose;
}
