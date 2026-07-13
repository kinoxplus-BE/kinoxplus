import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';

export class RegisterDeviceDto {
  @ApiProperty({ example: 'dGhpcyBpcyBhIHRlc3QgdG9rZW4...' })
  @IsString()
  @MinLength(10)
  fcmToken!: string;

  @ApiProperty({ enum: ['ios', 'android', 'web'], example: 'android' })
  @IsIn(['ios', 'android', 'web'])
  platform!: 'ios' | 'android' | 'web';
}
