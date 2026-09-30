import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { DeviceInfoDto } from './device-info.dto';

/**
 * Body for POST /auth/pair/redeem. The web client sends the code it read
 * from the QR (or from a manual entry field) and optional device metadata
 * so the resulting session shows up as "Web — Chrome on macOS" in the
 * user's sessions screen rather than a blank row.
 */
export class PairRedeemDto {
  @ApiProperty({
    example: 'a3f1b2c9d4e0',
    minLength: 8,
    maxLength: 32,
    description:
      'One-time pair code, valid for 60 seconds. Consumed on first successful redeem.',
  })
  @IsString()
  @Length(8, 32)
  code!: string;

  @ApiPropertyOptional({ type: DeviceInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceInfoDto)
  device?: DeviceInfoDto;
}

/** Response for POST /auth/pair. */
export class PairCreatedDto {
  @ApiProperty({
    example: 'a3f1b2c9d4e0',
    description:
      'Show this to the user as fallback text alongside the QR so they can type it in if the scan fails.',
  })
  code!: string;

  @ApiProperty({
    example: '2026-09-30T14:22:15.000Z',
    description: 'When the code stops working. 60 seconds after issue.',
  })
  expiresAt!: string;

  @ApiProperty({
    example: 'https://kinoxplus.com/pair/a3f1b2c9d4e0',
    description:
      'What the mobile app encodes into the QR image. The web client at /pair/:code parses the code from the path and calls /auth/pair/redeem.',
  })
  qrPayload!: string;
}
