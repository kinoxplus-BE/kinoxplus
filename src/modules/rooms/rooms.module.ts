import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QUEUES } from '../../jobs/queues';
import { ChatModule } from '../chat/chat.module';
import { LivekitModule } from '../livekit/livekit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StreamingModule } from '../streaming/streaming.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RoomInvitationsService } from './room-invitations.service';
import { RoomsController } from './rooms.controller';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

@Module({
  imports: [
    ChatModule,
    LivekitModule,
    NotificationsModule,
    StreamingModule,
    SubscriptionsModule,
    BullModule.registerQueue({ name: QUEUES.ROOMS }),
  ],
  controllers: [RoomsController],
  providers: [RoomsService, RoomsGateway, RoomInvitationsService],
  exports: [RoomsService, RoomInvitationsService],
})
export class RoomsModule {}
