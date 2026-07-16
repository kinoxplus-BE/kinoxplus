import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  Length,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'john@example.com',
    description: 'Email used to request the reset OTP',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
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

  @ApiProperty({
    example: 'correct horse battery',
    minLength: 8,
    maxLength: 72,
    description: 'At least 8 characters. No composition rules (NIST 800-63B).',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword!: string;
}
