import { Injectable, NotImplementedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';
import type { RefreshDto } from './dto/refresh.dto';
import type { RegisterDto } from './dto/register.dto';

/**
 * TODO(sprint-2) — implement per AGENTS.md §10:
 * - Argon2id password hashing (memory cost from ARGON2_MEMORY_COST)
 * - OTP via Termii/Brevo: hashed codes in OtpChallenge, short TTL,
 *   max attempts, rate limited
 * - Access JWT (15m) + rotating refresh tokens hashed in RefreshToken (30d);
 *   rotate on every refresh, revoke on logout
 * - Never log tokens, OTP codes, or password hashes
 */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  register(_dto: RegisterDto): Promise<never> {
    throw new NotImplementedException('auth.register — sprint 2');
  }

  login(_dto: LoginDto): Promise<never> {
    throw new NotImplementedException('auth.login — sprint 2');
  }

  refresh(_dto: RefreshDto): Promise<never> {
    throw new NotImplementedException('auth.refresh — sprint 2');
  }

  logout(_userId: string): Promise<never> {
    throw new NotImplementedException('auth.logout — sprint 2');
  }

  requestOtp(_dto: RequestOtpDto): Promise<never> {
    throw new NotImplementedException('auth.requestOtp — sprint 2');
  }

  verifyOtp(_dto: VerifyOtpDto): Promise<never> {
    throw new NotImplementedException('auth.verifyOtp — sprint 2');
  }
}
