import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import { ApiEnvelope } from '../../common/swagger/api-envelope.decorator';
import type { AuthUser } from '../../common/types';
import { ChatService } from '../chat/chat.service';
import { LivekitService } from '../livekit/livekit.service';
import { CreateInvitationsDto } from './dto/create-invitations.dto';
import { CreateRoomDto } from './dto/create-room.dto';
import { InvitationBatchResultDto } from './dto/invitation-responses.dto';
import { RoomInvitationsService } from './room-invitations.service';
import { RoomsService } from './rooms.service';

@ApiTags('Rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly chat: ChatService,
    private readonly livekit: LivekitService,
    private readonly invitations: RoomInvitationsService,
  ) {}

  @UseGuards(ThrottlerGuard)
  @Post()
  @ApiOperation({
    summary: 'Create a Watch Room',
    description:
      "Host is auto-added as the first member. A user can only be in one active room at a time: if you're already in another room, this returns 409 ALREADY_IN_ROOM with { currentRoomId, currentRoomCode }. Pass ?force=true to auto-leave the current room and create the new one.",
  })
  @ApiResponse({ status: 201, description: 'Room created' })
  @ApiResponse({
    status: 409,
    description: 'ALREADY_IN_ROOM (unless ?force=true)',
  })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRoomDto,
    @Query('force', new ParseBoolPipe({ optional: true })) force?: boolean,
  ) {
    return this.rooms.createRoom(user.id, dto.titleId, {
      isPrivate: dto.isPrivate,
      maxMembers: dto.maxMembers,
      force,
    });
  }

  /** Resolve a shareable invite code before connecting to the ws namespace. */
  @Get('code/:code')
  findByCode(@Param('code') code: string) {
    return this.rooms.findByCode(code);
  }

  /** Voice-plane entry: LiveKit token for members of the room. */
  @Post(':id/voice-token')
  async voiceToken(@CurrentUser() user: AuthUser, @Param('id') roomId: string) {
    await this.rooms.assertMember(roomId, user.id);
    let isHost = true;
    try {
      await this.rooms.assertHost(roomId, user.id);
    } catch {
      isHost = false;
    }
    const token = await this.livekit.mintToken(roomId, user.id, isHost);
    return { token, roomName: this.livekit.roomName(roomId) };
  }

  @Get(':id/messages')
  async messages(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Query() pagination: CursorPaginationDto,
  ) {
    await this.rooms.assertMember(roomId, user.id);
    return this.chat.history(roomId, pagination.limit, pagination.cursor);
  }

  // ────────────────────── Invitations ──────────────────────

  @Post(':id/invitations')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Host invites users by email and/or userId',
    description:
      'Batch invite (max 20 per call). Emails matching existing accounts get push + in-app notification; emails without accounts get an email containing the join universal link. Duplicates against pending invites and current members are skipped, not re-sent — check the counts on the response.',
  })
  @ApiEnvelope(InvitationBatchResultDto, { description: 'Invitations sent' })
  @ApiResponse({
    status: 400,
    description: 'NO_INVITEES | TOO_MANY_INVITEES',
  })
  @ApiResponse({ status: 403, description: 'ROOM_NOT_HOST' })
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id') roomId: string,
    @Body() dto: CreateInvitationsDto,
  ) {
    return this.invitations.createInvitations(roomId, user.id, dto);
  }

  @Delete(':id/invitations/:invitationId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Invited user declines an invitation',
    description:
      'Marks the invitation as DECLINED so it stops showing on the dashboard. Only the invited user themselves can decline.',
  })
  @ApiResponse({ status: 200, description: 'Invitation declined' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND' })
  async decline(
    @CurrentUser() user: AuthUser,
    @Param('invitationId') invitationId: string,
  ) {
    await this.invitations.decline(invitationId, user.id);
    return { message: 'Invitation declined.' };
  }
}
