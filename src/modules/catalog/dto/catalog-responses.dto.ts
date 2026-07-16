import { ApiProperty } from '@nestjs/swagger';

export class GenreDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4ghij1234' })
  id!: string;

  @ApiProperty({
    example: 'Comedy',
    description:
      'Canonical genre name — the same values accepted by preferredGenres at signup.',
  })
  name!: string;
}
