import { IsIn, IsString, Length, MinLength } from 'class-validator';

const OTP_PURPOSES = ['login', 'verify', 'reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export class RequestOtpDto {
  /** Email address or E.164 phone number. */
  @IsString()
  @MinLength(3)
  identifier!: string;

  @IsIn(OTP_PURPOSES)
  purpose!: OtpPurpose;
}

export class VerifyOtpDto {
  @IsString()
  @MinLength(3)
  identifier!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsIn(OTP_PURPOSES)
  purpose!: OtpPurpose;
}
