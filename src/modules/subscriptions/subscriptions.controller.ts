import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthUser } from '../../common/types';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Public()
  @Get('plans')
  listPlans() {
    return this.subscriptions.listPlans();
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.subscriptions.me(user.id);
  }
}
