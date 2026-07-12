import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { LivekitModule } from '../livekit/livekit.module';
import { RoomsController } from './rooms.controller';
import { RoomsGateway } from './rooms.gateway';
import { RoomsService } from './rooms.service';

@Module({
  imports: [ChatModule, LivekitModule],
  controllers: [RoomsController],
  providers: [RoomsService, RoomsGateway],
  exports: [RoomsService],
})
export class RoomsModule {}
