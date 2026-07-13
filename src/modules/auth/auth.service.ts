import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { MailService } from '../mail/mail.service';
import type { ChangePasswordDto } from './dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';
import type { RefreshDto } from './dto/refresh.dto';
import type { RegisterDto } from './dto/register.dto';
import type { ResetPasswordDto } from './dto/reset-password.dto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 3;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly argon2Options: argon2.Options;
  private readonly refreshSecret: string;
  private readonly refreshTtlSec: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {
    this.argon2Options = {
      type: argon2.argon2id,
      memoryCost: config.get<number>('ARGON2_MEMORY_COST', 19_456),
    };
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
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
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        passwordHash,
        displayName: dto.displayName,
      },
      select: { id: true, role: true, email: true, displayName: true },
    });

    const tokens = await this.issueTokens(user.id, user.role);

    if (user.email) {
      this.mail
        .sendWelcome(user.email, user.displayName)
        .catch((err) => this.logger.error('Welcome email failed', err));
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

    // Rotate: revoke the old one, issue a new pair.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user.id, stored.user.role);
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

    // Deliver the OTP.
    const isEmail = dto.identifier.includes('@');
    if (isEmail) {
      switch (dto.purpose) {
        case 'verify':
          await this.mail.sendVerificationOtp(dto.identifier, code);
          break;
        case 'reset':
          await this.mail.sendPasswordResetOtp(dto.identifier, code);
          break;
        case 'login':
          await this.mail.sendLoginOtp(dto.identifier, code);
          break;
      }
    } else {
      // Phone OTP — Termii integration (sprint 2 extension).
      this.logger.log(
        `[DEV] OTP for ${dto.identifier}: ${code} (SMS delivery not configured)`,
      );
    }

    return {
      message: `OTP sent to ${dto.identifier}.`,
      expiresIn: OTP_TTL_MS / 1000,
    };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        identifier: dto.identifier,
        purpose: dto.purpose,
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

    const isValid = this.verifyOtpHash(dto.code, challenge.codeHash);
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

    // Mark consumed.
    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

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

    // purpose === 'reset': return a short-lived verification token.
    return { verified: true, identifier: dto.identifier };
  }

  // ────────────────────── Password management ──────────────────────

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
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
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    // Revoke all other sessions.
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'Password changed. All other sessions revoked.' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    // Verify the OTP inline (single-step reset).
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: {
        identifier: dto.identifier,
        purpose: 'reset',
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

    const isValid = this.verifyOtpHash(dto.code, challenge.codeHash);
    if (!isValid) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException({
        code: 'OTP_INVALID',
        message: 'Invalid OTP code.',
      });
    }

    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });

    const isEmail = dto.identifier.includes('@');
    const user = await this.prisma.user.findFirst({
      where: isEmail ? { email: dto.identifier } : { phone: dto.identifier },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException({
        code: 'USER_NOT_FOUND',
        message: 'No account found for this identifier.',
      });
    }

    const newHash = await argon2.hash(dto.newPassword, this.argon2Options);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    // Revoke all sessions — force re-login everywhere.
    await this.prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return { message: 'Password reset successful. Please log in again.' };
  }

  // ────────────────────── Internals ──────────────────────

  private async issueTokens(userId: string, role: Role) {
    const accessToken = await this.jwt.signAsync({
      sub: userId,
      role,
    });

    const rawRefresh = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawRefresh);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt: new Date(Date.now() + this.refreshTtlSec * 1000),
      },
    });

    return { accessToken, refreshToken: rawRefresh };
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
