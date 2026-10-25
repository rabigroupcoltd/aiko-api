import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { resolve } from 'path';
import { RedisIoAdapter } from './adapters/redis-io.adapter';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { StatusInterceptor } from './common/interceptors/status.interceptor';
import { ResponsesService } from './common/responses/responses.service';
import { setupSwagger } from './swagger';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api', { exclude: ['delete-account'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) => {
        const messages = errors
          .map((error) => Object.values(error.constraints || {}))
          .flat()
          .join(', ');
        return new BadRequestException(messages || 'Validation failed');
      },
    }),
  );

  app.useGlobalInterceptors(new StatusInterceptor());

  app.useGlobalFilters(new AllExceptionsFilter(app.get(ResponsesService)));

  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' });
  app.enableShutdownHooks();

  setupSwagger(app);

  app.useStaticAssets(resolve(process.env.UPLOAD_DIR || './uploads'), { prefix: '/uploads/' });

  if (process.env.SOCKET_REDIS_ADAPTER === 'true') {
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);
    logger.log('Socket.IO scaling through the Redis Streams adapter');
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`REST      http://localhost:${port}/api`);
  logger.log(`Docs      http://localhost:${port}/api/docs`);
  logger.log(`WebSocket ws://localhost:${port}/ride`);
}

bootstrap();
