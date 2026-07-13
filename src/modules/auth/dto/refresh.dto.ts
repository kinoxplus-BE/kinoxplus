import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshDto {
  @ApiProperty({
    example: 'a1b2c3d4e5f6...',
    description: 'The refresh token received on login',
  })
  @IsString()
  @MinLength(16)
  refreshToken!: string;
}
