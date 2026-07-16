import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ApiEnvelope } from '../../common/swagger/api-envelope.decorator';
import type { AuthUser } from '../../common/types';
import { AuthService } from './auth.service';
import {
  AuthSessionDto,
  MessageResponseDto,
  OtpRequestedDto,
  OtpVerifiedDto,
  PasswordChangedDto,
  ResetTokenDto,
  TokenPairDto,
  UsernameAvailabilityDto,
} from './dto/auth-responses.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CheckUsernameDto } from './dto/check-username.dto';
import { LoginDto } from './dto/login.dto';
import { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@ApiTags('Auth')
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('register')
  @ApiOperation({
    summary: 'Register a new account (signup wizard submit)',
    description:
      'One-shot submit for the 3-step signup wizard: personal details (fullName, email, password, dateOfBirth — 13+), categories (preferredGenres, min 3), profile (username, avatarColor, bio). Creates the account, returns tokens, and auto-sends the email verification OTP — land the user on the "Check your email" screen and call POST /auth/otp/verify with purpose "verify". Duplicate errors are field-specific: EMAIL_EXISTS, USERNAME_TAKEN, PHONE_EXISTS.',
  })
  @ApiEnvelope(AuthSessionDto, {
    status: 201,
    description: 'Account created, tokens returned',
  })
  @ApiResponse({
    status: 409,
    description: 'EMAIL_EXISTS | USERNAME_TAKEN | PHONE_EXISTS',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed, INVALID_DOB, or AGE_RESTRICTION',
  })
  @ApiResponse({ status: 429, description: 'Too many requests (10/min)' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Get('username-available')
  @ApiOperation({
    summary: 'Check username availability',
    description:
      'Case-insensitive availability check for signup step 3 — call before submitting so "taken" is caught in the wizard, not after.',
  })
  @ApiEnvelope(UsernameAvailabilityDto, { description: 'Availability result' })
  usernameAvailable(@Query() dto: CheckUsernameDto) {
    return this.auth.usernameAvailable(dto.username);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(200)
  @Post('login')
  @ApiOperation({
    summary: 'Login with email + password',
    description:
      'Authenticates with email and password. Returns access and refresh tokens.',
  })
  @ApiEnvelope(AuthSessionDto, {
    description: 'Login successful, tokens returned',
  })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  @ApiResponse({ status: 429, description: 'Too many requests (10/min)' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'Exchanges a valid refresh token for a new access + refresh token pair. The old refresh token is revoked (rotation). If a revoked token is reused, all tokens for that user are revoked (compromise detection).',
  })
  @ApiEnvelope(TokenPairDto, { description: 'New token pair returned' })
  @ApiResponse({
    status: 401,
    description: 'Token invalid, expired, or reuse detected',
  })
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto);
  }

  @HttpCode(200)
  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Logout current session',
    description:
      'Revokes the provided refresh token. The access token stays valid until it expires (JWT_ACCESS_TTL — keep it short in production, e.g. 15 min).',
  })
  @ApiEnvelope(MessageResponseDto, { description: 'Logged out' })
  logout(@CurrentUser() user: AuthUser, @Body() dto: RefreshDto) {
    return this.auth.logout(user.id, dto.refreshToken);
  }

  @HttpCode(200)
  @Post('logout-all')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Logout all devices',
    description:
      'Revokes ALL refresh tokens for the user. Forces re-login on every device.',
  })
  @ApiEnvelope(MessageResponseDto, { description: 'All sessions revoked' })
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(user.id);
  }

  // ────────────────────── OTP ──────────────────────

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(200)
  @Post('otp/request')
  @ApiOperation({
    summary: 'Request an OTP code',
    description:
      'Sends a 6-digit OTP to the given email or phone number if an account exists (the response is identical either way, so accounts cannot be enumerated). Purpose can be: login (passwordless), verify (email/phone verification), or reset (password reset). Code expires in 10 minutes. Per identifier: 60s resend cooldown and a daily cap.',
  })
  @ApiEnvelope(OtpRequestedDto, { description: 'Generic acknowledgement' })
  @ApiResponse({
    status: 429,
    description: 'Too many requests (per-IP 5/min, per-identifier cooldown)',
  })
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(200)
  @Post('otp/verify')
  @ApiOperation({
    summary: 'Verify an OTP code',
    description:
      'Verifies the OTP code. Side effects depend on purpose: "verify" marks email/phone as verified, "login" returns tokens, "reset" returns a single-use resetToken (valid 15 min) to pass to POST /auth/reset-password.',
  })
  @ApiEnvelope([OtpVerifiedDto, AuthSessionDto, ResetTokenDto], {
    description:
      'OTP verified. Payload varies by purpose: verify → OtpVerifiedDto, login → AuthSessionDto (user + tokens), reset → ResetTokenDto (single-use resetToken).',
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
  @ApiResponse({ status: 403, description: 'Max attempts exceeded' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  // ────────────────────── Password ──────────────────────

  @HttpCode(200)
  @Post('change-password')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password (authenticated)',
    description:
      'Changes the password for the authenticated user. Requires the current password. Revokes all other sessions and returns a fresh token pair for this device.',
  })
  @ApiEnvelope(PasswordChangedDto, {
    description: 'Password changed, new accessToken + refreshToken returned',
  })
  @ApiResponse({ status: 401, description: 'Current password incorrect' })
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.id, dto);
  }

  @Public()
  @HttpCode(200)
  @Post('reset-password')
  @ApiOperation({
    summary: 'Reset password with OTP',
    description:
      'Resets the password after an OTP requested with purpose "reset". Two supported flows: (1) single-step — send the 6-digit code directly here with the new password; (2) two-step — verify the code via POST /auth/otp/verify first, then send the returned resetToken here instead of the code. Revokes all sessions and emails a security notice.',
  })
  @ApiEnvelope(MessageResponseDto, { description: 'Password reset successful' })
  @ApiResponse({
    status: 400,
    description: 'Invalid OTP/resetToken or user not found',
  })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }
}
