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
import { OutboxRelay, FanOutPublisher } from './workers/outbox-relay';
import { NotificationConsumer } from './modules/notifications/notifications.consumer';
import { RefundConsumer } from './modules/payments/refund.consumer';
import { PanchangService } from './modules/panchang/panchang.service';
import { PanchangJob } from './workers/panchang.job';
import { PgAdvisoryLock } from './workers/leader-lock';
import { Scheduler, LOCK_KEYS } from './workers/scheduler';
import { AnniversaryJob } from './workers/anniversary.job';
import { JoinLinkChaseJob } from './workers/join-link.job';
import { ReminderJob } from './workers/reminder.job';
import { SeriesCodesJob } from './workers/series-codes.job';
import { BookingOtpService } from './modules/auth/otp.service';
import { KycPurgeJob } from './workers/kyc-purge.job';
import { BookingService } from './modules/booking/booking.service';
import { ReviewsService } from './modules/reviews/reviews.service';
import { NotificationService } from './modules/notifications/notifications.service';
import type { ObjectStore } from './modules/storage/object-store';
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
    /*
     * Both consumers see every event. Refunds are not a kind of notification: a
     * devotee who cancels needs to be told AND to get their money back, and until
     * now only the first of those had any code behind it.
     */
    new FanOutPublisher([
      app.get(NotificationConsumer),
      app.get(RefundConsumer),
    ]),
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

  /*
   * The periodic jobs.
   *
   * Two of these were written, tested and started by nothing: accept windows never
   * expired, and one-sided reviews never published, which froze a purohit's rating
   * whenever the other party stayed quiet. `KycPurgeJob` is new but the obligation
   * is not — ADR 0010 promises a thirty-day purge, `doc_purge_after` is written on
   * every decision, and nothing ever deleted a document. The anniversary nudge is
   * likewise new machinery over an old read model that nothing ever sent.
   *
   * `PayoutService.enforceCreditLimit` is deliberately NOT here. It takes one
   * purohit, and sweeping it means iterating the whole roster on a timer to
   * recompute a value that only changes when a booking settles — it belongs on the
   * settlement path, not on a clock. Left for that change rather than wired into a
   * job that would do the wrong thing efficiently.
   *
   * Each takes its own advisory lock, so two instances can make progress on
   * different work rather than queueing behind one another. See `Scheduler`.
   */
  const db = app.get<Db>(DB);
  const scheduler = new Scheduler([
    {
      name: 'expire-accepts',
      intervalMs: 60_000,
      lockKey: LOCK_KEYS.expireAccepts,
      // Lateness is the cost here: an expired window that is still open is a
      // purohit holding a job they never answered.
      runAtBoot: true,
      run: () => app.get(BookingService).expireStaleAccepts(),
    },
    {
      name: 'publish-reviews',
      intervalMs: 3600_000,
      lockKey: LOCK_KEYS.publishReviews,
      run: () => app.get(ReviewsService).publishExpired(),
    },
    {
      name: 'anniversary-nudge',
      // Daily. The window it looks at is a month wide, so an exact hour is
      // meaningless and a more frequent run would only re-scan the same rows.
      intervalMs: 24 * 3600_000,
      lockKey: LOCK_KEYS.anniversary,
      run: () => new AnniversaryJob(db, app.get(NotificationService)).run(),
    },
    {
      /*
       * The day-before reminder, which has had a seeded template in three
       * languages and no emitter at all. Hourly, so each booking is reminded
       * roughly a day ahead at whatever hour the job reaches it, rather than the
       * whole of tomorrow's list going out the moment a calendar day rolls over —
       * which for a 3am rollover is a message nobody wants.
       */
      name: 'booking-reminder',
      intervalMs: 3600_000,
      lockKey: LOCK_KEYS.reminder,
      run: () => new ReminderJob(db, app.get(NotificationService)).run(),
    },
    {
      /*
       * A remote booking with no link is a devotee who has paid for a video call
       * they cannot join. Hourly, because the window that matters is the last day
       * before the ceremony.
       */
      name: 'join-link-chase',
      intervalMs: 3600_000,
      lockKey: LOCK_KEYS.joinLink,
      run: () => new JoinLinkChaseJob(db, app.get(NotificationService)).run(),
    },
    {
      /*
       * A multi-day series issues a distinct code per day and delivers only day
       * one's at confirmation. Hourly, because the window that matters is the
       * morning of each later day.
       */
      name: 'series-codes',
      intervalMs: 3600_000,
      lockKey: LOCK_KEYS.seriesCodes,
      run: () => new SeriesCodesJob(
        db, app.get(NotificationService), app.get(BookingOtpService), config.OTP_DEV_BYPASS,
      ).run(),
    },
    {
      name: 'kyc-purge',
      intervalMs: 24 * 3600_000,
      lockKey: LOCK_KEYS.kycPurge,
      run: () => new KycPurgeJob(db, app.get<ObjectStore>('OBJECT_STORE')).run(),
    },
  ], (key) => new PgAdvisoryLock(db, key));
  scheduler.start();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { relay.stop(); panchang.stop(); scheduler.stop(); });
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
  /*
   * Said on EVERY boot, including production, and deliberately not once at
   * deploy time. A deployment running cash-only is a commercial decision with a
   * revenue consequence, and the one place it is reliably noticed is the log line
   * somebody reads when they wonder why no money has arrived.
   */
  if (!config.PAYMENTS_ENABLED) {
    log.warn(
      'PAYMENTS ARE OFF — cash-only mode. Bookings confirm on submission with no '
      + 'token charged, and the devotee pays the purohit the full amount on the day.',
    );
    log.warn(
      'No platform fee is collected on any booking in this mode, and no due is '
      + 'recorded for it. Set PAYMENTS_ENABLED=true with RAZORPAY_* to start charging.',
    );
  } else if (!config.RAZORPAY_KEY_ID) {
    log.warn('payment gateway is FAKE — no real money moves. Set RAZORPAY_* to go live.');
  }
}

void bootstrap();
