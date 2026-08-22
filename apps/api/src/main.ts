import './common/load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule, CONFIG, DB } from './app.module';
import type { Config } from './common/config';
import type { Db } from './db/client';
import type { KvStore } from './common/kv';
import { KV } from './common/tokens';
import { OutboxService } from './domain/outbox';
import { OutboxRelay } from './workers/outbox-relay';
import { NotificationConsumer } from './modules/notifications/notifications.consumer';
import { PanchangService } from './modules/panchang/panchang.service';
import { PanchangJob } from './workers/panchang.job';
import { PgAdvisoryLock } from './workers/leader-lock';
import { securityHeaders, requestContext, rateLimit } from './common/security';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // The Razorpay webhook signature is computed over the exact bytes sent, so the
    // raw body must survive JSON parsing.
    rawBody: true,
    bufferLogs: false,
  });
  const config = app.get<Config>(CONFIG);
  const log = new Logger('bootstrap');

  app.use(securityHeaders());
  app.use(requestContext());
  app.use(rateLimit(app.get<KvStore>(KV)));

  app.enableCors({
    // Matched against the WHOLE `Origin` header, scheme included (e.g.
    // `https://app.themaithil.in`), so the pattern has to anchor there too.
    // `/\.themaithil\.in$/` (no `^https://`) required a literal dot immediately
    // before `themaithil.in` - present for any subdomain, but the apex origin
    // `https://themaithil.in` has `//` in that position, not `.`, so it never
    // matched. The address someone actually types was the one CORS blocked.
    origin: config.isProd ? [/^https:\/\/([a-z0-9-]+\.)*themaithil\.in$/] : true,
    credentials: true,
  });

  // Finish in-flight requests before dying, so a deploy never drops a payment webhook.
  app.enableShutdownHooks();

  const relay = new OutboxRelay(
    app.get<Db>(DB),
    app.get(OutboxService),
    app.get(NotificationConsumer),
  );
  relay.start();
  const panchang = new PanchangJob(
    app.get(PanchangService), config.LAUNCH_CITY_SLUG, config.BOOKING_HORIZON_DAYS,
    // Fixed key: any two processes racing this same job must contend for the same
    // lock. 0x50414e43 spells "PANC" - memorable, and distinct from any other
    // advisory lock this codebase might take later.
    new PgAdvisoryLock(app.get<Db>(DB), 0x50414e43),
  );
  panchang.start();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { relay.stop(); panchang.stop(); });
  }

  /**
   * A port clash is the most confusing failure in local dev, because the app keeps
   * working — served by the ORPHANED process that already holds the port. You read
   * the logs of the process that died, and debug an API that is not the one
   * answering your browser. Nest prints a raw EADDRINUSE stack, which buries it.
   */
  try {
    await app.listen(config.PORT, '0.0.0.0');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      log.error(
        `Port ${config.PORT} is already taken, almost certainly by an older API `
        + 'process. THAT process is still answering your browser, and it does not '
        + 'have any of your recent changes.\n\n'
        + `  lsof -ti :${config.PORT} | xargs -r kill -9\n\n`
        + 'then start again.',
      );
      process.exit(1);
    }
    throw e;
  }

  log.log(`the maithil api listening on :${config.PORT}`);
  log.log(
    `env=${config.NODE_ENV} city=${config.LAUNCH_CITY_SLUG} horizon=${config.BOOKING_HORIZON_DAYS}d ` +
    `redis=${config.REDIS_URL ? 'yes' : 'in-memory'} ` +
    `payments=${config.RAZORPAY_KEY_ID ? 'razorpay' : 'FAKE'} ` +
    `whatsapp=${config.WHATSAPP_API_KEY ? 'bsp' : 'console'}`,
  );
  if (config.OTP_DEV_BYPASS) {
    log.warn('OTP dev bypass is ON — codes are returned in the API response and are always 123456');
  }
  if (!config.RAZORPAY_KEY_ID) {
    log.warn('payment gateway is FAKE — no real money moves. Set RAZORPAY_* to go live.');
  }
}

void bootstrap();
