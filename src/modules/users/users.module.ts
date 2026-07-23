import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SessionsService } from './sessions.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [NotificationsModule],
  controllers: [UsersController],
  providers: [UsersService, SessionsService],
  exports: [UsersService],
})
export class UsersModule {}
