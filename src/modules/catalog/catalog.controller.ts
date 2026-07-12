import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import { CatalogService } from './catalog.service';

/** Browsing is public; playback is gated in the streaming module. */
@Public()
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('titles')
  listTitles(@Query() pagination: CursorPaginationDto) {
    return this.catalog.listTitles(pagination);
  }

  @Get('titles/:slug')
  getTitle(@Param('slug') slug: string) {
    return this.catalog.getBySlug(slug);
  }

  @Get('genres')
  listGenres() {
    return this.catalog.listGenres();
  }
}
