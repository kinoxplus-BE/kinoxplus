import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import type { AuthUser } from '../../common/types';
import { WatchlistService } from './watchlist.service';

@ApiTags('Watchlist')
@ApiBearerAuth()
@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get()
  @ApiOperation({
    summary: "List titles on the user's watchlist (cursor-paginated)",
  })
  list(
    @CurrentUser() user: AuthUser,
    @Query() pagination: CursorPaginationDto,
  ) {
    return this.watchlist.list(user.id, pagination.cursor, pagination.limit);
  }

  @Get('check/:titleId')
  @ApiOperation({
    summary: 'Is this title on my list?',
    description:
      'Cheap check used by the title detail screen to render the Add/Remove button state.',
  })
  check(@CurrentUser() user: AuthUser, @Param('titleId') titleId: string) {
    return this.watchlist.check(user.id, titleId);
  }

  @Post(':titleId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Add a title to the watchlist',
    description: 'Idempotent — adding a title already saved is a no-op.',
  })
  add(@CurrentUser() user: AuthUser, @Param('titleId') titleId: string) {
    return this.watchlist.add(user.id, titleId);
  }

  @Delete(':titleId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a title from the watchlist' })
  remove(@CurrentUser() user: AuthUser, @Param('titleId') titleId: string) {
    return this.watchlist.remove(user.id, titleId);
  }
}
