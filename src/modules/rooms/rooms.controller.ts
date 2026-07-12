import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import type { AuthUser } from '../../common/types';
import { ChatService } from '../chat/chat.service';
import { LivekitService } from '../livekit/livekit.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { RoomsService } from './rooms.service';

@Controller('rooms')
export class RoomsController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly chat: ChatService,
    private readonly livekit: LivekitService,
  ) {}

  @UseGuards(ThrottlerGuard)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRoomDto) {
    return this.rooms.createRoom(user.id, dto.titleId, {
      isPrivate: dto.isPrivate,
      maxMembers: dto.maxMembers,
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
}
