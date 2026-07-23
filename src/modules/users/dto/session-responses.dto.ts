import { ApiProperty } from '@nestjs/swagger';

export class SessionDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4ghij1234' })
  id!: string;

  @ApiProperty({
    example: "Samuel's iPhone",
    nullable: true,
    type: String,
  })
  deviceName!: string | null;

  @ApiProperty({ example: 'iPhone 15 Pro', nullable: true, type: String })
  deviceModel!: string | null;

  @ApiProperty({
    example: 'ios',
    enum: ['ios', 'android', 'web'],
    nullable: true,
    type: String,
  })
  platform!: string | null;

  @ApiProperty({ example: 'iOS 18.2', nullable: true, type: String })
  osVersion!: string | null;

  @ApiProperty({ example: '1.0.0', nullable: true, type: String })
  appVersion!: string | null;

  @ApiProperty({ example: '2026-07-19T18:03:12.000Z', type: String })
  lastUsedAt!: Date;

  @ApiProperty({ example: '105.119.24.106', nullable: true, type: String })
  lastUsedIp!: string | null;

  @ApiProperty({
    example: '2026-07-19T09:12:47.000Z',
    type: String,
    description: 'When this session was started.',
  })
  createdAt!: Date;

  @ApiProperty({
    example: '2026-08-18T09:12:47.000Z',
    type: String,
    description: 'When this session will auto-expire.',
  })
  expiresAt!: Date;
}
