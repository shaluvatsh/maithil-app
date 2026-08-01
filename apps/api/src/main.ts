import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { CONFIG, DB } from './app.module';
import type { Config } from './common/config';
import type { Db } from './db/client';
import { OutboxService } from './domain/outbox';
import { OutboxRelay, LoggingPublisher } from './workers/outbox-relay';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get<Config>(CONFIG);

  app.enableShutdownHooks();

  // The relay runs in-process at launch volume. It moves to its own machine the
  // day the API and the queue need to scale independently, and not before.
  const relay = new OutboxRelay(app.get<Db>(DB), app.get(OutboxService), new LoggingPublisher());
  relay.start();
  app.enableShutdownHooks();

  await app.listen(config.PORT);
  new Logger('bootstrap').log(
    `the maithil api listening on :${config.PORT} (${config.NODE_ENV}, city=${config.LAUNCH_CITY_SLUG})`,
  );
}

void bootstrap();
