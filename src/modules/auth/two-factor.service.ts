import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { generateSecret, verifySync } from 'otplib';
import * as QRCode from 'qrcode';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 4; // → 8 hex chars
// TOTP tolerance: ±30 seconds — one 30s step of drift, same as Google
// Authenticator's default.
const TOTP_EPOCH_TOLERANCE = 30;

/**
 * TOTP + backup-code operations. Doesn't know about JWTs or refresh
 * tokens — that lives in AuthService. This one owns the crypto and DB
 * touches for 2FA state.
 */
@Injectable()
export class TwoFactorService {
  private readonly appName: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.appName = config.get<string>('APP_NAME', 'KinoX+');
  }

  private verifyTotp(code: string, secret: string): boolean {
    return verifySync({
      token: code,
      secret,
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    }).valid;
  }

  private buildOtpAuthUrl(label: string, secret: string): string {
    // Standard otpauth format per Google Authenticator spec.
    // https://github.com/google/google-authenticator/wiki/Key-Uri-Format
    const issuer = encodeURIComponent(this.appName);
    const account = encodeURIComponent(label);
    return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}`;
  }

  // ────────────────────── Setup / Enable / Disable ──────────────────────

  /** Generate a new TOTP secret + QR. Does not commit — caller must
   * verify a code via `enable()` first. Secret is written to the User row
   * but `twoFactorEnabled` stays false until enable() succeeds. */
  async setup(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrCodeDataUrl: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, twoFactorEnabled: true },
    });
    if (!user) {
      throw new BadRequestException({
        code: 'USER_NOT_FOUND',
        message: 'User not found.',
      });
    }
    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_ALREADY_ENABLED',
        message: 'Disable 2FA first before setting up a new device.',
      });
    }

    const secret = generateSecret();
    const label = user.email ?? userId;
    const otpauthUrl = this.buildOtpAuthUrl(label, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    // Stash the pending secret — commits on /enable, cleared on /disable.
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret },
    });

    return { secret, otpauthUrl, qrCodeDataUrl };
  }

  /** Verify a first TOTP code against the pending secret, commit 2FA,
   * generate + return one-time backup codes (only shown here). */
  async enable(
    userId: string,
    code: string,
  ): Promise<{ backupCodes: string[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user || !user.twoFactorSecret) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_NOT_INITIALIZED',
        message: 'Call POST /auth/2fa/setup first.',
      });
    }
    if (user.twoFactorEnabled) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_ALREADY_ENABLED',
        message: 'Two-factor authentication is already enabled.',
      });
    }

    if (!this.verifyTotp(code, user.twoFactorSecret)) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_INVALID_CODE',
        message: 'Invalid code. Check the time on your device and try again.',
      });
    }

    const codes = this.generateBackupCodes();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: true },
      }),
      this.prisma.twoFactorBackupCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: this.hashCode(c) })),
      }),
    ]);

    return { backupCodes: codes };
  }

  /** Password + TOTP (or backup code) required. */
  async disable(userId: string, password: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
      },
    });
    if (!user || !user.passwordHash) {
      throw new BadRequestException({
        code: 'NO_PASSWORD',
        message: 'Account has no password set.',
      });
    }
    if (!user.twoFactorEnabled) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_NOT_ENABLED',
        message: 'Two-factor authentication is not enabled.',
      });
    }

    const validPassword = await argon2.verify(user.passwordHash, password);
    if (!validPassword) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is incorrect.',
      });
    }

    const validCode = await this.verifyCode(userId, user.twoFactorSecret, code);
    if (!validCode) {
      throw new BadRequestException({
        code: 'TWO_FACTOR_INVALID_CODE',
        message: 'Invalid code.',
      });
    }

    // Wipe secret + backup codes atomically.
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: false, twoFactorSecret: null },
      }),
      this.prisma.twoFactorBackupCode.deleteMany({ where: { userId } }),
    ]);
  }

  // ────────────────────── Verification (used at login) ──────────────────────

  /**
   * Verifies a TOTP code OR a single-use backup code for the given user.
   * Backup codes are consumed atomically here so they can't be reused.
   * Returns true iff either factor accepts the code.
   */
  async verifyCode(
    userId: string,
    twoFactorSecret: string | null,
    code: string,
  ): Promise<boolean> {
    if (twoFactorSecret && this.verifyTotp(code, twoFactorSecret)) {
      return true;
    }
    return this.consumeBackupCode(userId, code);
  }

  private async consumeBackupCode(
    userId: string,
    code: string,
  ): Promise<boolean> {
    // Backup codes are 8 hex chars, case-insensitive in the input.
    const normalized = code.trim().toLowerCase();
    if (!/^[a-f0-9]{8}$/.test(normalized)) return false;

    const codeHash = this.hashCode(normalized);
    // Atomic consume: only succeeds if the code exists AND is unused AND
    // belongs to this user (userId scoping prevents cross-user reuse).
    const result = await this.prisma.twoFactorBackupCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: new Date() },
    });
    return result.count === 1;
  }

  // ────────────────────── Internals ──────────────────────

  private generateBackupCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      codes.push(randomBytes(BACKUP_CODE_BYTES).toString('hex'));
    }
    return codes;
  }

  private hashCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
