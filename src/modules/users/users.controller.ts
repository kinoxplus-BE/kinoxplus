import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiEnvelope } from '../../common/swagger/api-envelope.decorator';
import type { AuthUser } from '../../common/types';
import { NotificationsService } from '../notifications/notifications.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { SessionDto } from './dto/session-responses.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SessionsService } from './sessions.service';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly sessions: SessionsService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile returned' })
  me(@CurrentUser() user: AuthUser) {
    return this.users.me(user.id);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update profile (display name, avatar)' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  @Post('me/devices')
  @ApiOperation({
    summary: 'Register device for push notifications',
    description:
      'Upserts FCM token. A token can migrate between users/devices.',
  })
  @ApiResponse({ status: 201, description: 'Device registered' })
  registerDevice(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.notifications.registerDevice(
      user.id,
      dto.fcmToken,
      dto.platform,
    );
  }

  // ────────────────────── Sessions (active devices) ──────────────────────

  @Get('me/sessions')
  @ApiOperation({
    summary: 'List active sessions',
    description:
      'One row per active refresh token (device). Most-recently-used first. Powers the "Manage devices" screen.',
  })
  @ApiEnvelope(SessionDto, { isArray: true, description: 'Active sessions' })
  listSessions(@CurrentUser() user: AuthUser) {
    return this.sessions.list(user.id);
  }

  @Delete('me/sessions/:id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Revoke a specific session',
    description:
      "Kicks that device out on its next request. If it's the caller's own session, they'll be logged out next time their access token expires.",
  })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  @ApiResponse({
    status: 404,
    description: 'Session not found or already revoked',
  })
  revokeSession(@CurrentUser() user: AuthUser, @Param('id') sessionId: string) {
    return this.sessions.revoke(user.id, sessionId);
  }
}
