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

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      // Flatten constraint messages so the envelope carries one readable string.
      exceptionFactory: (errors) => {
        const messages = errors
          .map((error) => Object.values(error.constraints || {}))
          .flat()
          .join(', ');
        return new BadRequestException(messages || 'Validation failed');
      },
    }),
  );

  // Syncs the HTTP status line to the `code` in the body.
  app.useGlobalInterceptors(new StatusInterceptor());

  // Catches anything that escapes a controller's own try/catch — guards, pipes,
  // and unexpected throws — so every response uses the same envelope.
  app.useGlobalFilters(new AllExceptionsFilter(app.get(ResponsesService)));

  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? '*' });
  app.enableShutdownHooks();

  // Mounted after the global prefix so every documented path already carries it.
  setupSwagger(app);

  // Serves uploads written by the LOCAL storage provider. Harmless when a
  // cloud provider is active — the directory simply stays empty.
  app.useStaticAssets(resolve(process.env.UPLOAD_DIR || './uploads'), { prefix: '/uploads/' });

  // Fan WebSocket events out through Redis so multiple instances stay in sync.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`REST      http://localhost:${port}/api`);
  logger.log(`Docs      http://localhost:${port}/api/docs`);
  logger.log(`WebSocket ws://localhost:${port}/ride`);
}

bootstrap();
