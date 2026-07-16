import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'john@example.com',
    description: 'Email used to request the reset OTP',
  })
  @IsString()
  @MinLength(3)
  identifier!: string;

  @ApiPropertyOptional({
    example: '482917',
    description:
      '6-digit OTP code (single-step flow). Required unless resetToken is provided.',
  })
  @ValidateIf((o: ResetPasswordDto) => !o.resetToken)
  @IsString()
  @Length(6, 6)
  code?: string;

  @ApiPropertyOptional({
    example: '3f1c…64-hex-chars…9ab2',
    description:
      'Single-use token returned by POST /auth/otp/verify with purpose "reset" (two-step flow). Takes precedence over code.',
  })
  @ValidateIf((o: ResetPasswordDto) => !o.code)
  @IsString()
  @Length(64, 64)
  resetToken?: string;

  @ApiProperty({ example: 'NewSecureP@ss1', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, and one number',
  })
  newPassword!: string;
}
