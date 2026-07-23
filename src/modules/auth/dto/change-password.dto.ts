import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { DeviceInfoDto, DeviceInfoField } from './device-info.dto';

export class ChangePasswordDto {
  @ApiProperty({ example: 'OldP@ss123' })
  @IsString()
  @MinLength(8)
  currentPassword!: string;

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

  /** Tags the fresh session issued after the password change so the current
   * device stays labelled in the sessions list. */
  @DeviceInfoField()
  device?: DeviceInfoDto;
}
