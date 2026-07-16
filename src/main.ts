import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { parseCorsOrigins } from './config/env';
import { RedisIoAdapter } from './redis/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  // Behind Render's load balancer: trust the first proxy hop so req.ip is
  // the real client IP (X-Forwarded-For). Without this, every request looks
  // like it comes from the LB and all users share one rate-limit bucket.
  app.set('trust proxy', 1);

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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger API docs for the frontend team.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('KinoX+ API')
    .setDescription(
      'Backend API for KinoX+ — digital entertainment platform with synced Watch Rooms.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis(config.getOrThrow<string>('REDIS_URL'));
  app.useWebSocketAdapter(redisIoAdapter);

  app.enableShutdownHooks();
  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
}

void bootstrap();
