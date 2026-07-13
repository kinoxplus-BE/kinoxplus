import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Length, MinLength } from 'class-validator';

const OTP_PURPOSES = ['login', 'verify', 'reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export class RequestOtpDto {
  @ApiProperty({
    example: 'john@example.com',
    description: 'Email address or E.164 phone number',
  })
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
