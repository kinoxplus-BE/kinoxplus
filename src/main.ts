import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { parseCorsOrigins } from './config/env';
import { RedisIoAdapter } from './redis/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Webhook signature verification (Paystack/Flutterwave/Stream/LiveKit)
    // needs the raw payload — exposed as req.rawBody.
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);

  const sentryDsn = config.get<string>('SENTRY_DSN');
  if (sentryDsn) {
    Sentry.init({
      dsn: sentryDsn,
      environment: config.get<string>('NODE_ENV'),
    });
  }

  app.use(helmet());
  app.enableCors({
    origin: parseCorsOrigins(config.get<string>('CORS_ORIGINS', '')),
    credentials: true,
  });

  // Validate at the boundary — every inbound HTTP payload.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Redis-backed Socket.io adapter so /rooms events reach every instance.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis(config.getOrThrow<string>('REDIS_URL'));
  app.useWebSocketAdapter(redisIoAdapter);

  app.enableShutdownHooks();
  await app.listen(config.get<number>('PORT', 3000));
}

void bootstrap();
