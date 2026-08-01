import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { LivekitModule } from '../livekit/livekit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StreamingModule } from '../streaming/streaming.module';
import { RoomInvitationsService } from './room-invitations.service';
import { RoomsController } from './rooms.controller';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

@Module({
  imports: [ChatModule, LivekitModule, NotificationsModule, StreamingModule],
  controllers: [RoomsController],
  providers: [RoomsService, RoomsGateway, RoomInvitationsService],
  exports: [RoomsService, RoomInvitationsService],
})
export class RoomsModule {}
