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
  SignupTokenDto,
  TokenPairDto,
  UsernameAvailabilityDto,
} from './dto/auth-responses.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CheckUsernameDto } from './dto/check-username.dto';
import { LoginDto } from './dto/login.dto';
import { RequestOtpDto, VerifyEmailDto, VerifyOtpDto } from './dto/otp.dto';
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
      'Final wizard submit ("Create Account" on step 3). Wizard choreography: step 1 collects fullName/email/password/dateOfBirth (13+); after step 2 (preferredGenres, min 3) call POST /auth/otp/request with purpose "signup" and verify the emailed code via POST /auth/otp/verify to receive a signupToken; step 3 collects username/avatarColor/bio; then submit everything here WITH the signupToken. Creates the account with emailVerified=true, returns tokens (go straight to dashboard), sends the welcome email. Errors: SIGNUP_TOKEN_INVALID (verify again), EMAIL_EXISTS, USERNAME_TAKEN, PHONE_EXISTS.',
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
    description:
      'Validation failed, INVALID_DOB, AGE_RESTRICTION, or SIGNUP_TOKEN_INVALID',
  })
  @ApiResponse({ status: 429, description: 'Too many requests (10/min)' })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('username-available')
  @ApiOperation({
    summary: 'Check username availability',
    description:
      'Case-insensitive availability check for signup step 3 — call before submitting so "taken" is caught in the wizard, not after.',
  })
  @ApiEnvelope(UsernameAvailabilityDto, { description: 'Availability result' })
  @ApiResponse({ status: 429, description: 'Too many requests (20/min)' })
  usernameAvailable(@Query() dto: CheckUsernameDto) {
    return this.auth.usernameAvailable(dto.username);
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(200)
  @Post('login')
  @ApiOperation({
    summary: 'Login with email/phone + password',
    description:
      'Authenticates with an identifier (email OR E.164 phone number) plus password. Returns access and refresh tokens.',
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
      'Sends a 6-digit OTP (10-min expiry) to the given email or phone. Purposes: signup (pre-registration email verification — fire after wizard step 2; requires the email to NOT have an account, 409 EMAIL_EXISTS otherwise), login (passwordless), verify (post-registration email/phone verification), reset (password reset). For login/verify/reset the response is identical whether or not an account exists. Per identifier: 60s resend cooldown ("Resend code" hits this same endpoint) and a daily cap.',
  })
  @ApiEnvelope(OtpRequestedDto, { description: 'Code sent (or generic ack)' })
  @ApiResponse({
    status: 409,
    description: 'purpose=signup only: EMAIL_EXISTS / PHONE_EXISTS',
  })
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
    summary: 'Verify an OTP code (public purposes)',
    description:
      'Verifies the OTP code for the public purposes: "signup" returns a single-use signupToken (valid 30 min) for POST /auth/register, "login" returns tokens, "reset" returns a single-use resetToken (valid 15 min) for POST /auth/reset-password. For post-registration email verification use POST /auth/verify-email (bearer required).',
  })
  @ApiEnvelope([SignupTokenDto, AuthSessionDto, ResetTokenDto], {
    description:
      'OTP verified. Payload varies by purpose: signup → SignupTokenDto, login → AuthSessionDto (user + tokens), reset → ResetTokenDto.',
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
  @ApiResponse({ status: 403, description: 'Max attempts exceeded' })
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto);
  }

  @HttpCode(200)
  @Post('verify-email')
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Verify the authenticated user's email",
    description:
      'Post-registration email verification. Requires the caller to be signed in — the identifier being verified is taken from the JWT, not the request body, so a leaked OTP can\'t be used to verify someone else\'s account. First request the code via POST /auth/otp/request with purpose "verify". First successful call also sends the welcome email.',
  })
  @ApiEnvelope(OtpVerifiedDto, { description: 'Email verified' })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
  @ApiResponse({ status: 403, description: 'Max attempts exceeded' })
  verifyEmail(@CurrentUser() user: AuthUser, @Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(user.id, dto);
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
