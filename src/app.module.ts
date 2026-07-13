import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { validateEnv } from './config/env';
import { JobsModule } from './jobs/jobs.module';
import { AdminModule } from './modules/admin/admin.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ChatModule } from './modules/chat/chat.module';
import { LivekitModule } from './modules/livekit/livekit.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { StreamingModule } from './modules/streaming/streaming.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { UsersModule } from './modules/users/users.module';
import { CloudinaryModule } from './modules/cloudinary/cloudinary.module';
import { MailModule } from './modules/mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    // App refuses to boot on missing/malformed env (AGENTS.md §4).
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // Never log tokens/OTP/hashes (AGENTS.md §13).
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    // Applied per-route (auth, OTP, room create) via @UseGuards(ThrottlerGuard).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // bullmq pins its own ioredis, so hand it options rather than a client.
        const url = new URL(config.getOrThrow<string>('REDIS_URL'));
        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username || undefined,
            password: url.password || undefined,
            ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
          },
        };
      },
    }),

    // Infra
    PrismaModule,
    RedisModule,
    JobsModule,
    MailModule,
    CloudinaryModule,

    // MVP feature modules
    AuthModule,
    UsersModule,
    CatalogModule,
    RoomsModule, // ⭐ Watch Rooms
    StreamingModule,
    LivekitModule,
    SubscriptionsModule,
    PaymentsModule,
    NotificationsModule,
    ChatModule,
    AdminModule,
    WebhooksModule,

    // [POST-MVP] — structured now, built later
    RecommendationsModule,
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [
    // Order matters: authenticate, then authorize.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
