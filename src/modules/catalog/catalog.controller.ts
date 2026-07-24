import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import { ApiEnvelope } from '../../common/swagger/api-envelope.decorator';
import { CatalogService } from './catalog.service';
import { CatalogTitleDto, GenreDto } from './dto/catalog-responses.dto';

/** Browsing is public; playback is gated in the streaming module. */
@ApiTags('Catalog')
@Public()
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('titles')
  @ApiOperation({
    summary: 'Browse the catalog',
    description:
      'READY titles only, cursor-paginated. POC TMDB fields include posterUrl and backdropUrl; playback URLs are intentionally not exposed here.',
  })
  @ApiEnvelope(CatalogTitleDto, {
    isArray: true,
    description: 'READY catalog titles',
  })
  listTitles(@Query() pagination: CursorPaginationDto) {
    return this.catalog.listTitles(pagination);
  }

  @Get('titles/:slug')
  @ApiOperation({ summary: 'Get a title by slug' })
  @ApiEnvelope(CatalogTitleDto, { description: 'READY catalog title' })
  getTitle(@Param('slug') slug: string) {
    return this.catalog.getBySlug(slug);
  }

  @Get('genres')
  @ApiOperation({
    summary: 'List all genres',
    description:
      'Canonical genre list, alphabetical. Use these names to render the signup step-2 chips — POST /auth/register validates preferredGenres against exactly this list.',
  })
  @ApiEnvelope(GenreDto, { isArray: true, description: 'All genres' })
  listGenres() {
    return this.catalog.listGenres();
  }
}
