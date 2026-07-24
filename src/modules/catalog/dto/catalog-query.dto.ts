import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { GENRES, type GenreName } from '../../../common/constants/genres';
import { CursorPaginationDto } from '../../../common/dto/pagination.dto';

export class CatalogTitlesQueryDto extends CursorPaginationDto {
  @ApiPropertyOptional({
    enum: GENRES,
    example: 'Comedy',
    description:
      'Optional canonical genre filter. Use GET /catalog/genres for the full list.',
  })
  @IsOptional()
  @IsIn(GENRES)
  genre?: GenreName;
}

export class CatalogHomeQueryDto {
  @ApiPropertyOptional({
    default: 12,
    minimum: 1,
    maximum: 40,
    description: 'Maximum titles per curated home row.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(40)
  limitPerGenre: number = 12;
}
