import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import type { AuthUser } from '../../common/types';
import { SendFriendRequestDto } from './dto/send-request.dto';
import { FriendsService } from './friends.service';

@ApiTags('Friends')
@ApiBearerAuth()
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get()
  @ApiOperation({ summary: 'List my accepted friends (cursor-paginated)' })
  list(
    @CurrentUser() user: AuthUser,
    @Query() pagination: CursorPaginationDto,
  ) {
    return this.friends.listFriends(
      user.id,
      pagination.cursor,
      pagination.limit,
    );
  }

  @Get('requests/incoming')
  @ApiOperation({ summary: 'Pending friend requests sent to me' })
  incoming(
    @CurrentUser() user: AuthUser,
    @Query() pagination: CursorPaginationDto,
  ) {
    return this.friends.listIncoming(
      user.id,
      pagination.cursor,
      pagination.limit,
    );
  }

  @Get('requests/outgoing')
  @ApiOperation({ summary: 'Pending friend requests I have sent' })
  outgoing(
    @CurrentUser() user: AuthUser,
    @Query() pagination: CursorPaginationDto,
  ) {
    return this.friends.listOutgoing(
      user.id,
      pagination.cursor,
      pagination.limit,
    );
  }

  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('requests')
  @ApiOperation({
    summary: 'Send a friend request to a user by username',
    description:
      'If the target already sent you a pending request, this call accepts it instead of creating a parallel one. If you previously had a request declined, this replaces that row with a fresh pending request.',
  })
  sendRequest(
    @CurrentUser() user: AuthUser,
    @Body() dto: SendFriendRequestDto,
  ) {
    return this.friends.sendRequest(user.id, dto.username);
  }

  @Post('requests/:id/accept')
  @HttpCode(200)
  @ApiOperation({ summary: 'Accept a pending incoming friend request' })
  accept(@CurrentUser() user: AuthUser, @Param('id') requestId: string) {
    return this.friends.respond(user.id, requestId, 'accept');
  }

  @Post('requests/:id/decline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Decline a pending incoming friend request' })
  decline(@CurrentUser() user: AuthUser, @Param('id') requestId: string) {
    return this.friends.respond(user.id, requestId, 'decline');
  }

  @Delete('requests/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a pending outgoing friend request' })
  cancel(@CurrentUser() user: AuthUser, @Param('id') requestId: string) {
    return this.friends.cancel(user.id, requestId);
  }

  @Delete(':userId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Unfriend the target user' })
  unfriend(
    @CurrentUser() user: AuthUser,
    @Param('userId') targetUserId: string,
  ) {
    return this.friends.unfriend(user.id, targetUserId);
  }
}
