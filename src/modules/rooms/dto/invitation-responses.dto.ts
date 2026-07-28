import { ApiProperty } from '@nestjs/swagger';

export class InvitedHostDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4user1' })
  id!: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  displayName!: string;

  @ApiProperty({ example: 'priyan', nullable: true, type: String })
  username!: string | null;

  @ApiProperty({ example: null, nullable: true, type: String })
  avatarUrl!: string | null;

  @ApiProperty({ example: '#3652D9', nullable: true, type: String })
  avatarColor!: string | null;
}

export class InvitedTitleDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4title1' })
  id!: string;

  @ApiProperty({ example: 'The Dark Knight' })
  name!: string;

  @ApiProperty({ example: 'the-dark-knight-2008-tmdb-155' })
  slug!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://image.tmdb.org/t/p/w500/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
  })
  posterUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://image.tmdb.org/t/p/w780/hkBaDkMWbLaf8B1lsWsKX7Ew3Xq.jpg',
  })
  backdropUrl!: string | null;
}

export class InvitedRoomDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4room1' })
  id!: string;

  @ApiProperty({ example: 'Q7M4RD' })
  code!: string;

  @ApiProperty({ example: 'LOBBY', enum: ['LOBBY', 'PLAYING', 'PAUSED'] })
  status!: string;

  @ApiProperty({ example: true })
  isPrivate!: boolean;

  @ApiProperty({ example: 20 })
  maxMembers!: number;

  @ApiProperty({
    type: () => InvitedTitleDto,
    nullable: true,
    description:
      'The currently-selected movie, or null if the room is in lobby mode with no movie picked yet. Host can pick or change via the title:change socket event.',
  })
  title!: InvitedTitleDto | null;

  @ApiProperty({ type: () => InvitedHostDto })
  host!: InvitedHostDto;
}

export class RoomInvitationDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4invite1' })
  id!: string;

  @ApiProperty({ example: '2026-07-20T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-07-21T12:00:00.000Z' })
  expiresAt!: Date;

  @ApiProperty({ type: () => InvitedRoomDto })
  room!: InvitedRoomDto;
}

export class InvitationBatchResultDto {
  @ApiProperty({
    example: 3,
    description: 'How many new invitations were created.',
  })
  invited!: number;

  @ApiProperty({
    example: 1,
    description: 'Skipped because they were already active members.',
  })
  skippedAlreadyMembers!: number;

  @ApiProperty({
    example: 2,
    description: 'Skipped because they already had a pending invitation.',
  })
  skippedAlreadyInvited!: number;
}
