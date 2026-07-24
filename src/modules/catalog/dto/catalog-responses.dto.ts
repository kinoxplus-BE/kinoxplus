import { ApiProperty } from '@nestjs/swagger';
import { GENRES, type GenreName } from '../../../common/constants/genres';
import { TitleStatus, TitleType } from '../../../generated/prisma/client';

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

export class TitleGenreDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4title1234' })
  titleId!: string;

  @ApiProperty({ example: 'cmd9x0abc0000v0f4genre1234' })
  genreId!: string;

  @ApiProperty({ type: () => GenreDto })
  genre!: GenreDto;
}

export class CatalogTitleDto {
  @ApiProperty({ example: 'cmd9x0abc0000v0f4title1234' })
  id!: string;

  @ApiProperty({ example: 'the-dark-knight-2008-tmdb-155' })
  slug!: string;

  @ApiProperty({ example: 'The Dark Knight' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Batman raises the stakes in his war on crime.',
  })
  description!: string | null;

  @ApiProperty({ enum: TitleType, example: TitleType.MOVIE })
  type!: TitleType;

  @ApiProperty({ type: Number, nullable: true, example: 2008 })
  year!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 9120,
    description: 'Runtime in seconds.',
  })
  durationSec!: number | null;

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

  @ApiProperty({ enum: TitleStatus, example: TitleStatus.READY })
  status!: TitleStatus;

  @ApiProperty({ example: '2026-07-24T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({ example: '2026-07-24T12:00:00.000Z' })
  updatedAt!: Date;

  @ApiProperty({ type: () => [TitleGenreDto] })
  genres!: TitleGenreDto[];
}

export class CatalogHomeRowDto {
  @ApiProperty({ enum: GENRES, example: 'Comedy' })
  genre!: GenreName;

  @ApiProperty({ type: () => [CatalogTitleDto] })
  titles!: CatalogTitleDto[];
}

export class CatalogHomeDto {
  @ApiProperty({ type: () => [CatalogHomeRowDto] })
  rows!: CatalogHomeRowDto[];
}
