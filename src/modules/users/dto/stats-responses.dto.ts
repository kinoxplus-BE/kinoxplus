import { ApiProperty } from '@nestjs/swagger';

export class UserStatsDto {
  @ApiProperty({ example: 7, description: 'Rooms this user has hosted.' })
  roomsHosted!: number;

  @ApiProperty({
    example: 42,
    description:
      'Total watch time rounded down to whole hours. Derived from WatchHistory positions.',
  })
  hoursWatched!: number;

  @ApiProperty({
    example: 12,
    description: 'Distinct titles the user finished (completed=true).',
  })
  moviesWatched!: number;

  @ApiProperty({
    example: 0,
    description:
      'Mutual friend count. Currently 0 — the Friendship model ships in a follow-up.',
  })
  friendsCount!: number;

  @ApiProperty({
    example: 0,
    description:
      'Saved-for-later count. Currently 0 — the Watchlist model ships in a follow-up.',
  })
  watchlistCount!: number;
}
