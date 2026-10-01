import { Module } from '@nestjs/common';
import { FriendsModule } from '../friends/friends.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RoomsModule } from '../rooms/rooms.module';
import { WatchlistModule } from '../watchlist/watchlist.module';
import { SessionsService } from './sessions.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [NotificationsModule, RoomsModule, FriendsModule, WatchlistModule],
  controllers: [UsersController],
  providers: [UsersService, SessionsService],
  exports: [UsersService],
})
export class UsersModule {}
