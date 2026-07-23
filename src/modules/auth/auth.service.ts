import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import {
  isUniqueViolation,
  uniqueViolationTarget,
} from '../../common/utils/prisma-errors';
import type { Role } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MailQueue } from '../mail/mail.queue';
import { TwoFactorService } from './two-factor.service';
import type { TwoFactorChallengeDto } from './dto/two-factor.dto';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { DeviceInfoDto } from './dto/device-info.dto';
import type { GoogleSignInDto } from './dto/google-auth.dto';
import type { LoginDto } from './dto/login.dto';
import type {
  OtpPurpose,
  RequestOtpDto,
  VerifyEmailDto,
  VerifyOtpDto,
} from './dto/otp.dto';
import type { RefreshDto } from './dto/refresh.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 3;
const OTP_RESEND_COOLDOWN_SEC = 60; // per identifier+purpose
const OTP_DAILY_CAP = 10; // per identifier, all purposes combined
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Server-side purposes for single-use tokens issued by verifyOtp. Never
// accepted from clients (the DTO whitelists signup|login|verify|reset).
const RESET_TOKEN_PURPOSE = 'reset_token';
const SIGNUP_TOKEN_PURPOSE = 'signup_token';
// Window to finish the profile step (username/color/bio) after verifying.
const SIGNUP_TOKEN_TTL_MS = 30 * 60 * 1000;
// 2FA challenge: user proved factor 1 (password/OTP/Google), now must
// prove factor 2 within this window.
const TWO_FACTOR_CHALLENGE_PURPOSE = 'two_factor_challenge';
const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MIN_AGE_YEARS = 13;

/**
 * Request-time context threaded from the controller into the service —
 * what device is signing in and from where — so the resulting refresh
 * token row captures the session's identity.
 */
export interface SessionContext {
  device?: DeviceInfoDto;
  ip?: string;
}

/** Internal option bag for issueTokens. */
interface IssueTokensOptions {
  rotateFromId?: string;
  device?: DeviceInfoDto;
  ip?: string;
}

// Returned by register/login/verifyOtp(login) — what the app needs to render.
// avatarUrl is a Cloudinary URL populated after upload; until then, avatarColor
// is the swatch shown in the UI.
const SESSION_USER_SELECT = {
  id: true,
  role: true,
  email: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
  emailVerified: true,
} as const;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly argon2Options: argon2.Options;
  private readonly refreshTtlSec: number;
  // Verified against when login hits an unknown email, so the response takes
  // the same time as a real password check (no user-enumeration via timing).
  private dummyHash?: Promise<string>;
  // Optional — POST /auth/google returns 400 if not configured.
  private readonly googleClientId?: string;
  private readonly googleOAuthClient?: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mailQueue: MailQueue,
    private readonly redis: RedisService,
    private readonly twoFactor: TwoFactorService,
  ) {
    this.argon2Options = {
      type: argon2.argon2id,
      // OWASP-recommended profile: m=19456 KiB, t=2, p=1.
      memoryCost: config.get<number>('ARGON2_MEMORY_COST', 19_456),
      timeCost: 2,
      parallelism: 1,
    };
    this.refreshTtlSec = config.get<number>('JWT_REFRESH_TTL', 86_400); // 1 day for dev
    this.googleClientId = config.get<string>('GOOGLE_CLIENT_ID');
    if (this.googleClientId) {
      this.googleOAuthClient = new OAuth2Client(this.googleClientId);
    } else {
      this.logger.warn(
        'GOOGLE_CLIENT_ID not set — POST /auth/google will return 400.',
      );
    }
  }

  // ────────────────────── Register ──────────────────────

  async register(dto: RegisterDto, session: SessionContext = {}) {
    this.assertMinimumAge(dto.dateOfBirth);

    // The wizard verified this email BEFORE the profile step: consume the
    // single-use token issued by verifyOtp(signup). Atomic consume — a
    // token can create exactly one account.
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: {
        identifier: dto.email,
        purpose: SIGNUP_TOKEN_PURPOSE,
        codeHash: this.hashToken(dto.signupToken),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new BadRequestException({
        code: 'SIGNUP_TOKEN_INVALID',
        message:
          'Email verification is missing or expired. Verify your email again.',
      });
    }

    const clash = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          { username: dto.username },
          ...(dto.phone ? [{ phone: dto.phone }] : []),
        ],
      },
      select: { email: true, username: true },
    });
    if (clash) {
      if (clash.email === dto.email) throw this.duplicateUserError('email');
      if (clash.username === dto.username)
        throw this.duplicateUserError('username');
      throw this.duplicateUserError('phone');
    }

    const passwordHash = await argon2.hash(dto.password, this.argon2Options);
    const user = await this.prisma.user
      .create({
        data: {
          email: dto.email,
          phone: dto.phone,
          username: dto.username,
          passwordHash,
          displayName: dto.fullName,
          dateOfBirth: new Date(dto.dateOfBirth),
          preferredGenres: dto.preferredGenres,
          avatarColor: dto.avatarColor,
          bio: dto.bio,
          // Proven by the consumed signup token.
          emailVerified: true,
        },
        select: SESSION_USER_SELECT,
      })
      .catch((err: unknown) => {
        // Concurrent register slips past the pre-check; map the unique
        // violation to the same field-specific 409 instead of a 500.
        if (isUniqueViolation(err)) {
          const target = uniqueViolationTarget(err);
          if (target.includes('username'))
            throw this.duplicateUserError('username');
          if (target.includes('phone')) throw this.duplicateUserError('phone');
          throw this.duplicateUserError('email');
        }
        throw err;
      });

    const tokens = await this.issueTokens(user.id, user.role, {
      device: dto.device ?? session.device,
      ip: session.ip,
    });

    if (user.email) {
      // Email is already verified at this point — straight to the welcome.
      this.mailQueue
        .queueWelcome(user.email, user.displayName)
        .catch((err) =>
          this.logger.error('Failed to queue welcome email', err),
        );
    }

    return { user, ...tokens };
  }

  /** Signup step-3 helper: case-insensitive availability check. */
  async usernameAvailable(username: string) {
    const existing = await this.prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    return { available: !existing };
  }

  // ────────────────────── Login ──────────────────────

  async login(dto: LoginDto, session: SessionContext = {}) {
    // identifier is either an email (has "@") or E.164 phone (starts with "+").
    const isEmail = dto.identifier.includes('@');
    const user = await this.prisma.user.findUnique({
      where: isEmail ? { email: dto.identifier } : { phone: dto.identifier },
      select: {
        ...SESSION_USER_SELECT,
        passwordHash: true,
        twoFactorEnabled: true,
      },
    });
    if (!user || !user.passwordHash) {
      // Burn the same argon2 cost as a real check before rejecting.
      await argon2
        .verify(await this.getDummyHash(), dto.password)
        .catch(() => false);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      });
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password.',
      });
    }

    const result = await this.issueSessionOrChallenge(
      user.id,
      user.role,
      user.twoFactorEnabled,
      { device: dto.device ?? session.device, ip: session.ip },
    );
    if ('requiresTwoFactor' in result) return result;
    const { passwordHash: _, twoFactorEnabled: __, ...safeUser } = user;
    return { user: safeUser, ...result };
  }

  // ────────────────────── Google sign-in ──────────────────────

  /**
   * Verify a Google ID token, find-or-create the user, hand off to the
   * standard session/2FA-challenge flow. Existing accounts (same email)
   * are silently linked — no merge complexity, just log them in.
   */
  async googleSignIn(dto: GoogleSignInDto, session: SessionContext = {}) {
    if (!this.googleOAuthClient || !this.googleClientId) {
      throw new BadRequestException({
        code: 'GOOGLE_NOT_CONFIGURED',
        message: 'Google sign-in is not configured on this server.',
      });
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.googleOAuthClient.verifyIdToken({
        idToken: dto.idToken,
        audience: this.googleClientId,
      });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn('Google idToken verification failed', err);
      throw new UnauthorizedException({
        code: 'GOOGLE_TOKEN_INVALID',
        message: 'Invalid Google credential.',
      });
    }

    if (!payload || !payload.email || !payload.email_verified) {
      throw new UnauthorizedException({
        code: 'GOOGLE_EMAIL_UNVERIFIED',
        message: 'Google account has no verified email.',
      });
    }

    const email = payload.email.toLowerCase();
    let user = await this.prisma.user.findUnique({
      where: { email },
      select: { ...SESSION_USER_SELECT, twoFactorEnabled: true },
    });

    if (!user) {
      // New Google user — auto-create with a placeholder username the
      // client can prompt them to change. Password is null (they must
      // continue via Google or use the reset flow to set one).
      const username = `user_${randomBytes(4).toString('hex')}`;
      const displayName = payload.name?.trim() || email.split('@')[0];
      const avatarUrl = payload.picture ?? null;
      user = await this.prisma.user.create({
        data: {
          email,
          displayName,
          username,
          avatarUrl,
          emailVerified: true,
        },
        select: { ...SESSION_USER_SELECT, twoFactorEnabled: true },
      });
      this.mailQueue
        .queueWelcome(email, displayName)
        .catch((err) =>
          this.logger.error('Failed to queue welcome email', err),
        );
    }

    const result = await this.issueSessionOrChallenge(
      user.id,
      user.role,
      user.twoFactorEnabled,
      { device: dto.device ?? session.device, ip: session.ip },
    );
    if ('requiresTwoFactor' in result) return result;
    const { twoFactorEnabled: _, ...safeUser } = user;
    return { user: safeUser, ...result };
  }

  // ────────────────────── Token refresh ──────────────────────

  async refresh(dto: RefreshDto, session: SessionContext = {}) {
    const tokenHash = this.hashToken(dto.refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, role: true } } },
    });

    if (!stored) {
      throw new UnauthorizedException({
        code: 'TOKEN_INVALID',
        message: 'Refresh token not found.',
      });
    }

    if (stored.revokedAt) {
      // Reuse detected — revoke entire family for this user.
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId} — all tokens revoked.`,
      );
      throw new UnauthorizedException({
        code: 'TOKEN_REUSED',
        message:
          'Suspicious activity detected. All sessions have been revoked.',
      });
    }

    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException({
        code: 'TOKEN_EXPIRED',
        message: 'Refresh token has expired.',
      });
    }

    // Rotation (revoke old + issue new) happens atomically in issueTokens.
    // Device info is inherited from the previous token; IP is refreshed.
    return this.issueTokens(stored.user.id, stored.user.role, {
      rotateFromId: stored.id,
      ip: session.ip,
    });
  }

  // ────────────────────── Logout ──────────────────────

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { userId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { message: 'Logged out successfully.' };
  }

  async logoutAll(userId: string) {
    const [_, user] = await Promise.all([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      }),
    ]);

    if (user?.email) {
      // Security-notice: "someone kicked you off all your devices" is a
      // real user wants to hear about it, same as password change/reset.
      this.mailQueue
        .queueAllSessionsRevoked(user.email)
        .catch((err) =>
          this.logger.error('Failed to queue all-sessions-revoked email', err),
        );
    }

    return { message: 'All sessions revoked.' };
  }

  // ────────────────────── OTP ──────────────────────

  async requestOtp(dto: RequestOtpDto) {
    const isEmail = dto.identifier.includes('@');
    const user = await this.prisma.user.findFirst({
      where: isEmail ? { email: dto.identifier } : { phone: dto.identifier },
      select: { id: true },
    });

    // signup: pre-registration verification — the identifier must NOT have
    // an account yet. Fail-fast BEFORE the rate-limit counters increment so
    // an honest typo (or someone else registering that email first) doesn't
    // burn the identifier's daily OTP quota. The per-IP throttler still
    // caps enumeration attempts.
    if (dto.purpose === 'signup') {
      if (user) {
        throw this.duplicateUserError(isEmail ? 'email' : 'phone');
      }
      await this.enforceOtpRateLimits(dto.identifier, dto.purpose);
      await this.createAndDeliverOtp(dto.identifier, dto.purpose);
      return {
        message: `Verification code sent to ${dto.identifier}.`,
        expiresIn: OTP_TTL_MS / 1000,
      };
    }

    // login/verify/reset: same response whether or not an account exists, so
    // the endpoint can't be used to enumerate accounts or spam strangers.
    // Rate limits must run before the existence check to keep the response
    // shape uniform for hits and misses.
    await this.enforceOtpRateLimits(dto.identifier, dto.purpose);
    const genericResponse = {
      message: `If an account exists for ${dto.identifier}, a code has been sent.`,
      expiresIn: OTP_TTL_MS / 1000,
    };
    if (!user) return genericResponse;

    await this.createAndDeliverOtp(dto.identifier, dto.purpose);

    return genericResponse;
  }

  async verifyOtp(dto: VerifyOtpDto, session: SessionContext = {}) {
    await this.verifyAndConsumeChallenge(dto.identifier, dto.purpose, dto.code);

    // Handle purpose-specific side effects.
    if (dto.purpose === 'signup') {
      // Email proven before the account exists: issue a single-use token the
      // wizard carries through the profile step into POST /auth/register.
      const signupToken = randomBytes(32).toString('hex');
      await this.prisma.otpChallenge.create({
        data: {
          identifier: dto.identifier,
          codeHash: this.hashToken(signupToken),
          purpose: SIGNUP_TOKEN_PURPOSE,
          expiresAt: new Date(Date.now() + SIGNUP_TOKEN_TTL_MS),
        },
      });
      return {
        verified: true,
        signupToken,
        expiresIn: SIGNUP_TOKEN_TTL_MS / 1000,
      };
    }

    if (dto.purpose === 'login') {
      const isEmail = dto.identifier.includes('@');
      const user = await this.prisma.user.findFirst({
        where: isEmail ? { email: dto.identifier } : { phone: dto.identifier },
        select: { ...SESSION_USER_SELECT, twoFactorEnabled: true },
      });
      if (!user) {
        throw new BadRequestException({
          code: 'USER_NOT_FOUND',
          message: 'No account found for this identifier.',
        });
      }
      const result = await this.issueSessionOrChallenge(
        user.id,
        user.role,
        user.twoFactorEnabled,
        { device: dto.device ?? session.device, ip: session.ip },
      );
      if ('requiresTwoFactor' in result) return result;
      const { twoFactorEnabled: _, ...safeUser } = user;
      return { user: safeUser, ...result };
    }

    // purpose === 'reset': issue a single-use, short-lived reset token so the
    // frontend can verify the code on one screen and set the new password on
    // the next (POST /auth/reset-password with resetToken instead of code).
    const resetToken = randomBytes(32).toString('hex');
    await this.prisma.otpChallenge.create({
      data: {
        identifier: dto.identifier,
        codeHash: this.hashToken(resetToken),
        purpose: RESET_TOKEN_PURPOSE,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    return {
      verified: true,
      resetToken,
      expiresIn: RESET_TOKEN_TTL_MS / 1000,
    };
  }

  // ────────────────────── Email verification (authenticated) ──────────────────────

  /**
   * Post-registration email verification. Consumes an OTP requested with
   * purpose "verify" and flips `emailVerified=true` on the authenticated
   * user's account only — protects against a leaked OTP being used to
   * verify someone else's identifier.
   */
  async verifyEmail(userId: string, dto: VerifyEmailDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailVerified: true,
      },
    });
    if (!user || !user.email) {
      throw new BadRequestException({
        code: 'NO_EMAIL',
        message: 'This account has no email address to verify.',
      });
    }

    await this.verifyAndConsumeChallenge(user.email, 'verify', dto.code);

    if (!user.emailVerified) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
      // First-time verification: send the welcome email.
      this.mailQueue
        .queueWelcome(user.email, user.displayName)
        .catch((err) =>
          this.logger.error('Failed to queue welcome email', err),
        );
    }

    return { verified: true };
  }

  // ────────────────────── Password management ──────────────────────

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    session: SessionContext = {},
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, role: true, email: true },
    });
    if (!user || !user.passwordHash) {
      throw new BadRequestException({
        code: 'NO_PASSWORD',
        message: 'Account has no password set.',
      });
    }

    const valid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!valid) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    const newHash = await argon2.hash(dto.newPassword, this.argon2Options);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash: newHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    // Fresh pair for this device, so "all other sessions revoked" is true.
    const tokens = await this.issueTokens(userId, user.role, {
      device: dto.device ?? session.device,
      ip: session.ip,
    });

    if (user.email) {
      this.mailQueue
        .queuePasswordChanged(user.email)
        .catch((err) =>
          this.logger.error('Failed to queue password-changed email', err),
        );
    }

    return {
      message: 'Password changed. All other sessions were signed out.',
      ...tokens,
    };
  }

  async resetPassword(dto: ResetPasswordDto) {
    if (dto.resetToken) {
      // Two-step flow: OTP already verified via /auth/otp/verify, which
      // issued this single-use token. Atomic consume prevents replay.
      const consumed = await this.prisma.otpChallenge.updateMany({
        where: {
          identifier: dto.identifier,
          purpose: RESET_TOKEN_PURPOSE,
          codeHash: this.hashToken(dto.resetToken),
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count === 0) {
        throw new BadRequestException({
          code: 'RESET_TOKEN_INVALID',
          message: 'Reset token is invalid or expired. Request a new OTP.',
        });
      }
    } else if (dto.code) {
      // Single-step flow: OTP code supplied directly with the new password.
      await this.verifyAndConsumeChallenge(dto.identifier, 'reset', dto.code);
    } else {
      throw new BadRequestException({
        code: 'RESET_PROOF_REQUIRED',
        message: 'Provide either the OTP code or a resetToken.',
      });
    }

    const isEmail = dto.identifier.includes('@');
    const user = await this.prisma.user.findFirst({
      where: isEmail ? { email: dto.identifier } : { phone: dto.identifier },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new BadRequestException({
        code: 'USER_NOT_FOUND',
        message: 'No account found for this identifier.',
      });
    }

    const newHash = await argon2.hash(dto.newPassword, this.argon2Options);
    // Password swap + global session revocation succeed or fail together.
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    if (user.email) {
      this.mailQueue
        .queuePasswordChanged(user.email)
        .catch((err) =>
          this.logger.error('Failed to queue password-changed email', err),
        );
    }

    return { message: 'Password reset successful. Please log in again.' };
  }

  // ────────────────────── Two-factor authentication ──────────────────────

  /**
   * Completes a 2FA-gated login: consumes the challenge token atomically,
   * verifies the TOTP or backup code, then mints tokens. Called from
   * POST /auth/2fa/challenge after /auth/login returned requiresTwoFactor.
   */
  async twoFactorChallenge(
    dto: TwoFactorChallengeDto,
    session: SessionContext = {},
  ) {
    // Look up the challenge before consuming so we can find the user.
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        purpose: TWO_FACTOR_CHALLENGE_PURPOSE,
        codeHash: this.hashToken(dto.challengeToken),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!challenge) {
      throw new UnauthorizedException({
        code: 'TWO_FACTOR_CHALLENGE_INVALID',
        message: 'Login challenge is invalid or expired. Sign in again.',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: challenge.identifier },
      select: { ...SESSION_USER_SELECT, twoFactorSecret: true },
    });
    if (!user) {
      throw new UnauthorizedException({
        code: 'TWO_FACTOR_CHALLENGE_INVALID',
        message: 'Login challenge is invalid or expired. Sign in again.',
      });
    }

    const codeValid = await this.twoFactor.verifyCode(
      user.id,
      user.twoFactorSecret,
      dto.code,
    );
    if (!codeValid) {
      // Do NOT consume the challenge on a bad code — user retries with a
      // fresh code without needing to log in again. But cap attempts via
      // the standard challenge attempts counter.
      const updated = await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });
      if (updated.attempts >= OTP_MAX_ATTEMPTS) {
        await this.prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        });
        throw new ForbiddenException({
          code: 'TWO_FACTOR_MAX_ATTEMPTS',
          message: 'Too many failed attempts. Sign in again.',
        });
      }
      throw new BadRequestException({
        code: 'TWO_FACTOR_INVALID_CODE',
        message: `Invalid code. ${OTP_MAX_ATTEMPTS - updated.attempts} attempts remaining.`,
      });
    }

    // Success — burn the challenge.
    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

    const tokens = await this.issueTokens(user.id, user.role, {
      device: dto.device ?? session.device,
      ip: session.ip,
    });
    const { twoFactorSecret: _, ...safeUser } = user;
    return { user: safeUser, ...tokens };
  }

  /**
   * Central helper: after factor 1 (password / OTP / social) succeeds, this
   * either mints tokens or — if the user has 2FA enabled — returns a
   * challenge the client redeems on POST /auth/2fa/challenge.
   */
  private async issueSessionOrChallenge(
    userId: string,
    role: Role,
    twoFactorEnabled: boolean,
    session: SessionContext,
  ): Promise<
    | { accessToken: string; refreshToken: string }
    | { requiresTwoFactor: true; challengeToken: string; expiresIn: number }
  > {
    if (!twoFactorEnabled) {
      return this.issueTokens(userId, role, {
        device: session.device,
        ip: session.ip,
      });
    }
    const challengeToken = randomBytes(32).toString('hex');
    await this.prisma.otpChallenge.create({
      data: {
        identifier: userId,
        codeHash: this.hashToken(challengeToken),
        purpose: TWO_FACTOR_CHALLENGE_PURPOSE,
        expiresAt: new Date(Date.now() + TWO_FACTOR_CHALLENGE_TTL_MS),
      },
    });
    return {
      requiresTwoFactor: true,
      challengeToken,
      expiresIn: TWO_FACTOR_CHALLENGE_TTL_MS / 1000,
    };
  }

  // ────────────────────── Internals ──────────────────────

  /**
   * Signs an access token and persists a hashed refresh token. When
   * `rotateFromId` is given, revoking the old token and creating the new one
   * happen in one transaction so a mid-flight failure can't strand the user
   * with both tokens dead. On rotation, device metadata from the previous
   * token is carried onto the new one so the "session" identity survives.
   */
  private async issueTokens(
    userId: string,
    role: Role,
    opts: IssueTokensOptions = {},
  ) {
    const accessToken = await this.jwt.signAsync({
      sub: userId,
      role,
    });

    const rawRefresh = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawRefresh);

    // On rotation, inherit device metadata from the previous token unless
    // the caller explicitly overrode it. Keeps the session's identity
    // stable across refreshes so it stays as one row in the sessions UI.
    let device = opts.device;
    if (opts.rotateFromId && !device) {
      const previous = await this.prisma.refreshToken.findUnique({
        where: { id: opts.rotateFromId },
        select: {
          deviceName: true,
          deviceModel: true,
          platform: true,
          osVersion: true,
          appVersion: true,
        },
      });
      if (previous) {
        device = {
          deviceName: previous.deviceName ?? undefined,
          deviceModel: previous.deviceModel ?? undefined,
          platform: previous.platform as 'ios' | 'android' | 'web' | undefined,
          osVersion: previous.osVersion ?? undefined,
          appVersion: previous.appVersion ?? undefined,
        };
      }
    }

    const createNew = this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        deviceName: device?.deviceName,
        deviceModel: device?.deviceModel,
        platform: device?.platform,
        osVersion: device?.osVersion,
        appVersion: device?.appVersion,
        lastUsedIp: opts.ip,
        expiresAt: new Date(Date.now() + this.refreshTtlSec * 1000),
      },
    });

    if (opts.rotateFromId) {
      await this.prisma.$transaction([
        this.prisma.refreshToken.update({
          where: { id: opts.rotateFromId },
          data: { revokedAt: new Date() },
        }),
        createNew,
      ]);
    } else {
      await createNew;
    }

    return { accessToken, refreshToken: rawRefresh };
  }

  /**
   * Looks up the newest active challenge, enforces the attempt cap, checks
   * the code in constant time, and consumes it. Shared by verifyOtp and the
   * single-step reset flow.
   */
  private async verifyAndConsumeChallenge(
    identifier: string,
    purpose: string,
    code: string,
  ): Promise<void> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        identifier,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!challenge) {
      throw new BadRequestException({
        code: 'OTP_EXPIRED',
        message: 'OTP has expired or was not found. Request a new one.',
      });
    }

    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      throw new ForbiddenException({
        code: 'OTP_MAX_ATTEMPTS',
        message: 'Too many failed attempts. Request a new OTP.',
      });
    }

    const isValid = this.verifyOtpHash(code, challenge.codeHash);
    if (!isValid) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: `Invalid OTP. ${OTP_MAX_ATTEMPTS - challenge.attempts - 1} attempts remaining.`,
      });
    }

    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
  }

  /**
   * Per-identifier abuse controls, enforced in Redis so they hold across
   * instances: a resend cooldown per purpose plus a daily cap. The per-IP
   * throttler alone can't stop a distributed attacker from email-bombing
   * one victim.
   */
  private async enforceOtpRateLimits(
    identifier: string,
    purpose: string,
  ): Promise<void> {
    const redis = this.redis.client;

    const cooldownKey = `otp:cooldown:${purpose}:${identifier}`;
    const acquired = await redis.set(
      cooldownKey,
      '1',
      'EX',
      OTP_RESEND_COOLDOWN_SEC,
      'NX',
    );
    if (!acquired) {
      throw new HttpException(
        {
          code: 'OTP_COOLDOWN',
          message: `Please wait ${OTP_RESEND_COOLDOWN_SEC} seconds before requesting another code.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const dailyKey = `otp:daily:${identifier}`;
    const sends = await redis.incr(dailyKey);
    if (sends === 1) {
      await redis.expire(dailyKey, 86_400);
    }
    if (sends > OTP_DAILY_CAP) {
      throw new HttpException(
        {
          code: 'OTP_DAILY_LIMIT',
          message:
            'Daily OTP limit reached for this identifier. Try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Creates a fresh challenge for identifier+purpose (invalidating previous
   * ones) and delivers it. Callers handle rate limiting: requestOtp enforces
   * limits first, the signup path primes the cooldown instead.
   */
  private async createAndDeliverOtp(
    identifier: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    const code = this.generateOtpCode();

    await this.prisma.otpChallenge.updateMany({
      where: {
        identifier,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });

    await this.prisma.otpChallenge.create({
      data: {
        identifier,
        codeHash: this.hashOtp(code),
        purpose,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    if (identifier.includes('@')) {
      // Enqueued, not sent inline: Brevo latency/outages never block or
      // fail the endpoint; the queue retries with backoff.
      await this.mailQueue.queueOtp(identifier, code, purpose);
    } else {
      // Phone OTP — Termii integration (sprint 2 extension).
      this.logger.log(
        `[DEV] OTP for ${identifier}: ${code} (SMS delivery not configured)`,
      );
    }
  }

  private assertMinimumAge(dateOfBirth: string): void {
    const dob = new Date(dateOfBirth);
    const now = new Date();
    if (Number.isNaN(dob.getTime()) || dob > now) {
      throw new BadRequestException({
        code: 'INVALID_DOB',
        message: 'Date of birth must be a valid date in the past.',
      });
    }

    let age = now.getFullYear() - dob.getFullYear();
    const monthDiff = now.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) {
      age -= 1;
    }
    if (age < MIN_AGE_YEARS) {
      throw new BadRequestException({
        code: 'AGE_RESTRICTION',
        message: `You must be at least ${MIN_AGE_YEARS} years old to create an account.`,
      });
    }
  }

  private duplicateUserError(
    field: 'email' | 'username' | 'phone',
  ): ConflictException {
    const byField = {
      email: {
        code: 'EMAIL_EXISTS',
        message: 'An account with this email already exists.',
      },
      username: {
        code: 'USERNAME_TAKEN',
        message: 'This username is already taken.',
      },
      phone: {
        code: 'PHONE_EXISTS',
        message: 'An account with this phone number already exists.',
      },
    } as const;
    return new ConflictException(byField[field]);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= argon2.hash(
      'kinoxplus.timing-equalizer',
      this.argon2Options,
    );
    return this.dummyHash;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private generateOtpCode(): string {
    return String(randomInt(100_000, 999_999));
  }

  private hashOtp(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private verifyOtpHash(code: string, storedHash: string): boolean {
    const inputHash = this.hashOtp(code);
    const a = Buffer.from(inputHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
