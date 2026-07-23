import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
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

  // ────────────────────── Avatar upload ──────────────────────

  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      // 5MB cap — anything a phone camera produces fits; huge files get
      // rejected before we bother Cloudinary.
      limits: { fileSize: 5 * 1024 * 1024 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload / replace avatar',
    description:
      'multipart/form-data with a single "file" field. Max 5MB. Accepted: JPEG, PNG, WebP, GIF, HEIC/HEIF. Cloudinary crops to 400×400 with face detection and returns the secure URL, which is saved to avatarUrl on your account. Response returns the updated user.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Avatar updated' })
  @ApiResponse({
    status: 400,
    description: 'NO_FILE | INVALID_FILE_TYPE | UPLOADS_NOT_CONFIGURED',
  })
  @ApiResponse({ status: 413, description: 'File larger than 5MB' })
  uploadAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.users.uploadAvatar(user.id, file);
  }

  @Delete('me/avatar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remove avatar',
    description:
      'Clears avatarUrl so the UI falls back to the avatarColor swatch. The old image stays in Cloudinary (cleanup job pending).',
  })
  @ApiResponse({ status: 200, description: 'Avatar removed' })
  removeAvatar(@CurrentUser() user: AuthUser) {
    return this.users.removeAvatar(user.id);
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
