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
import type { Role } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MailQueue } from '../mail/mail.queue';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';
import type { RefreshDto } from './dto/refresh.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 3;
const OTP_RESEND_COOLDOWN_SEC = 60; // per identifier+purpose
const OTP_DAILY_CAP = 10; // per identifier, all purposes combined
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Server-side purpose for the single-use token issued by verifyOtp(reset).
// Never accepted from clients (DTO whitelist is login|verify|reset).
const RESET_TOKEN_PURPOSE = 'reset_token';

/** Prisma unique-constraint violation (duplicate key). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly argon2Options: argon2.Options;
  private readonly refreshTtlSec: number;
  // Verified against when login hits an unknown email, so the response takes
  // the same time as a real password check (no user-enumeration via timing).
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mailQueue: MailQueue,
    private readonly redis: RedisService,
  ) {
    this.argon2Options = {
      type: argon2.argon2id,
      // OWASP-recommended profile: m=19456 KiB, t=2, p=1.
      memoryCost: config.get<number>('ARGON2_MEMORY_COST', 19_456),
      timeCost: 2,
      parallelism: 1,
    };
    this.refreshTtlSec = config.get<number>('JWT_REFRESH_TTL', 86_400); // 1 day for dev
  }

  // ────────────────────── Register ──────────────────────

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: dto.email },
          ...(dto.phone ? [{ phone: dto.phone }] : []),
        ],
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'USER_EXISTS',
        message: 'An account with this email or phone already exists.',
      });
    }

    const passwordHash = await argon2.hash(dto.password, this.argon2Options);
    let user: {
      id: string;
      role: Role;
      email: string | null;
      displayName: string;
    };
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          phone: dto.phone,
          passwordHash,
          displayName: dto.displayName,
        },
        select: { id: true, role: true, email: true, displayName: true },
      });
    } catch (err) {
      // Concurrent register with the same email/phone slips past the
      // pre-check; surface it as the same 409 instead of a 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'USER_EXISTS',
          message: 'An account with this email or phone already exists.',
        });
      }
      throw err;
    }

    const tokens = await this.issueTokens(user.id, user.role);

    if (user.email) {
      this.mailQueue
        .queueWelcome(user.email, user.displayName)
        .catch((err) =>
          this.logger.error('Failed to queue welcome email', err),
        );
    }

    return { user, ...tokens };
  }

  // ────────────────────── Login ──────────────────────

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        role: true,
        email: true,
        displayName: true,
        passwordHash: true,
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

    const tokens = await this.issueTokens(user.id, user.role);
    const { passwordHash: _, ...safeUser } = user;
    return { user: safeUser, ...tokens };
  }

  // ────────────────────── Token refresh ──────────────────────

  async refresh(dto: RefreshDto) {
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
    return this.issueTokens(stored.user.id, stored.user.role, stored.id);
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
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { message: 'All sessions revoked.' };
  }

  // ────────────────────── OTP ──────────────────────

  async requestOtp(dto: RequestOtpDto) {
    await this.enforceOtpRateLimits(dto.identifier, dto.purpose);

    // Same response whether or not an account exists, so this endpoint can't
    // be used to enumerate accounts or send mail to arbitrary strangers.
    const genericResponse = {
      message: `If an account exists for ${dto.identifier}, a code has been sent.`,
      expiresIn: OTP_TTL_MS / 1000,
    };

    const isEmail = dto.identifier.includes('@');
    const user = await this.prisma.user.findFirst({
      where: isEmail ? { email: dto.identifier } : { phone: dto.identifier },
      select: { id: true },
    });
    if (!user) return genericResponse;

    const code = this.generateOtpCode();
    const codeHash = this.hashOtp(code);

    // Invalidate existing unexpired OTPs for same identifier+purpose.
    await this.prisma.otpChallenge.updateMany({
      where: {
        identifier: dto.identifier,
        purpose: dto.purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });

    await this.prisma.otpChallenge.create({
      data: {
        identifier: dto.identifier,
        codeHash,
        purpose: dto.purpose,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    if (isEmail) {
      // Enqueued, not sent inline: Brevo latency/outages never block or
      // fail this endpoint; the queue retries with backoff.
      await this.mailQueue.queueOtp(dto.identifier, code, dto.purpose);
    } else {
      // Phone OTP — Termii integration (sprint 2 extension).
      this.logger.log(
        `[DEV] OTP for ${dto.identifier}: ${code} (SMS delivery not configured)`,
      );
    }

    return genericResponse;
  }

  async verifyOtp(dto: VerifyOtpDto) {
    await this.verifyAndConsumeChallenge(dto.identifier, dto.purpose, dto.code);

    // Handle purpose-specific side effects.
    if (dto.purpose === 'verify') {
      const isEmail = dto.identifier.includes('@');
      if (isEmail) {
        await this.prisma.user.updateMany({
          where: { email: dto.identifier },
          data: { emailVerified: true },
        });
      } else {
        await this.prisma.user.updateMany({
          where: { phone: dto.identifier },
          data: { phoneVerified: true },
        });
      }
      return { verified: true };
    }

    if (dto.purpose === 'login') {
      const isEmail = dto.identifier.includes('@');
      const user = await this.prisma.user.findFirst({
        where: isEmail ? { email: dto.identifier } : { phone: dto.identifier },
        select: { id: true, role: true, email: true, displayName: true },
      });
      if (!user) {
        throw new BadRequestException({
          code: 'USER_NOT_FOUND',
          message: 'No account found for this identifier.',
        });
      }
      const tokens = await this.issueTokens(user.id, user.role);
      return { user, ...tokens };
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

  // ────────────────────── Password management ──────────────────────

  async changePassword(userId: string, dto: ChangePasswordDto) {
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
    const tokens = await this.issueTokens(userId, user.role);

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

  // ────────────────────── Internals ──────────────────────

  /**
   * Signs an access token and persists a hashed refresh token. When
   * `rotateFromId` is given, revoking the old token and creating the new one
   * happen in one transaction so a mid-flight failure can't strand the user
   * with both tokens dead.
   */
  private async issueTokens(userId: string, role: Role, rotateFromId?: string) {
    const accessToken = await this.jwt.signAsync({
      sub: userId,
      role,
    });

    const rawRefresh = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawRefresh);

    const createNew = this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + this.refreshTtlSec * 1000),
      },
    });

    if (rotateFromId) {
      await this.prisma.$transaction([
        this.prisma.refreshToken.update({
          where: { id: rotateFromId },
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
