import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
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
