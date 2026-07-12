import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '../../generated/prisma/client';
import { SubscriptionsService } from '../../modules/subscriptions/subscriptions.service';
import type { AuthenticatedRequest } from '../types';

/**
 * Gates playback-URL issuance behind an active subscription (AGENTS.md §8).
 * Apply per-route; the using module must import SubscriptionsModule.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Missing access token.',
      });
    }
    if (user.role === Role.ADMIN) return true;

    if (!(await this.subscriptions.isActive(user.id))) {
      throw new ForbiddenException({
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'An active subscription is required to play content.',
      });
    }
    return true;
  }
}
