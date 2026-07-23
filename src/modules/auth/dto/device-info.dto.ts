import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const PLATFORMS = ['ios', 'android', 'web'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Client-supplied metadata about the device signing in. Attached to the
 * refresh token that gets issued so the user can later see + revoke this
 * session from GET/DELETE /users/me/sessions.
 */
export class DeviceInfoDto {
  @ApiPropertyOptional({
    example: "Samuel's iPhone",
    maxLength: 60,
    description: 'Human-readable label shown on the sessions screen.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  deviceName?: string;

  @ApiPropertyOptional({ example: 'iPhone 15 Pro', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  deviceModel?: string;

  @ApiPropertyOptional({ enum: PLATFORMS, example: 'ios' })
  @IsOptional()
  @IsIn(PLATFORMS)
  platform?: Platform;

  @ApiPropertyOptional({ example: 'iOS 18.2', maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  osVersion?: string;

  @ApiPropertyOptional({ example: '1.0.0', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  appVersion?: string;
}

/** Mixin — nest under `device` on login/register bodies. */
export function DeviceInfoField() {
  return function (target: object, key: string): void {
    ApiPropertyOptional({ type: DeviceInfoDto })(target, key);
    Type(() => DeviceInfoDto)(target, key);
    ValidateNested()(target, key);
    IsOptional()(target, key);
  };
}
