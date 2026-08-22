import { Module, Global } from '@nestjs/common';
import { APP_GUARD, APP_FILTER, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { CONFIG, DB, KV } from './common/tokens';
import { createDb, type Db } from './db/client';
import { loadConfig, type Config } from './common/config';
import { MemoryKv, RedisKv, type KvStore } from './common/kv';
import { DomainExceptionFilter } from './common/http-errors';
import { CacheHeaderInterceptor } from './common/cache';
import { IdempotencyService } from './common/idempotency';
import { AuditService } from './common/audit';
import { LedgerService } from './domain/ledger';
import { OutboxService } from './domain/outbox';
import { SlotService } from './domain/slots';
import { AuthService } from './modules/auth/auth.service';
import { OtpService, BookingOtpService } from './modules/auth/otp.service';
import { JwtAuthGuard } from './modules/auth/guards';
import { AuthController } from './modules/auth/auth.controller';
import { CatalogService } from './modules/catalog/catalog.service';
import { OffersService } from './modules/catalog/offers.service';
import { StatsService } from './modules/catalog/stats.service';
import { CatalogController } from './modules/catalog/catalog.controller';
import { AvailabilityService } from './modules/availability/availability.service';
import { PricingService } from './modules/booking/pricing.service';
import { BookingService } from './modules/booking/booking.service';
import { BookingController } from './modules/booking/booking.controller';
import { HealthController } from './modules/health.controller';
import { SearchService } from './modules/search/search.service';
import { PurohitController } from './modules/purohit/purohit.controller';
import { VerificationController } from './modules/admin/verification.controller';
import { ReviewsController } from './modules/reviews/reviews.controller';
import { ReviewsService } from './modules/reviews/reviews.service';
import { SearchController } from './modules/search/search.controller';
import { BookingReadController, AdminController } from './modules/booking/booking-read.controller';
import { RazorpayClient, FakeGateway, type PaymentGateway } from './modules/payments/razorpay.client';
import { S3ObjectStore, InMemoryObjectStore, type ObjectStore } from './modules/storage/object-store';
import { PurohitKycController } from './modules/purohit/kyc.controller';
import { PaymentsService } from './modules/payments/payments.service';
import { PaymentsController } from './modules/payments/payments.controller';
import { PayoutService } from './modules/payouts/payouts.service';
import { PayoutController } from './modules/payouts/payouts.controller';
import { NotificationService } from './modules/notifications/notifications.service';
import { NotificationConsumer } from './modules/notifications/notifications.consumer';
import { WhatsAppChannel, SmsChannel, ConsoleChannel, type Channel } from './modules/notifications/channels';
import { PanchangService } from './modules/panchang/panchang.service';
import { PanchangController } from './modules/panchang/panchang.controller';

export { CONFIG, DB, KV } from './common/tokens';

/**
 * Single Nest module for now. The bounded contexts are enforced by folder structure
 * and lint boundaries rather than by Nest modules - splitting into feature modules
 * buys ceremony, not isolation, until there is a second team. See ADR 0001.
 */
@Global()
@Module({
  controllers: [
    HealthController, AuthController, CatalogController,
    SearchController, BookingController, BookingReadController, AdminController,
    PaymentsController, PayoutController, PanchangController, PurohitController,
    // Both of these were written complete and correct, and never registered — so
    // every route on them 404'd. The verification queue rendered "empty" and the
    // Approve button did nothing; reviews could not be submitted or read at all.
    // Nothing failed loudly, because an unmounted controller is indistinguishable
    // from a URL that was never meant to exist. routes.test.ts now enforces this.
    VerificationController, ReviewsController,
    // Purohit identity documents. Nothing in the product could create a `kyc_records`
    // row before this, so the admin queue counted documents that could not exist and
    // `kyc_status` could never leave 'pending'.
    PurohitKycController,
  ],
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    { provide: DB, useFactory: (cfg: Config): Db => createDb(cfg.DATABASE_URL), inject: [CONFIG] },
    {
      provide: KV,
      useFactory: async (cfg: Config): Promise<KvStore> => {
        if (!cfg.REDIS_URL) return new MemoryKv();
        const { default: Redis } = await import('ioredis');
        return new RedisKv(new Redis(cfg.REDIS_URL) as never);
      },
      inject: [CONFIG],
    },

    { provide: LedgerService, useFactory: (db: Db) => new LedgerService(db), inject: [DB] },
    { provide: OutboxService, useFactory: () => new OutboxService() },
    { provide: SlotService, useFactory: () => new SlotService() },
    { provide: AuditService, useFactory: () => new AuditService() },
    {
      provide: IdempotencyService,
      useFactory: (db: Db) => new IdempotencyService(db), inject: [DB],
    },
    {
      provide: OtpService,
      useFactory: (kv: KvStore, cfg: Config) =>
        new OtpService(kv, cfg.JWT_ACCESS_SECRET, cfg.OTP_DEV_BYPASS),
      inject: [KV, CONFIG],
    },
    {
      provide: BookingOtpService,
      useFactory: (cfg: Config) => new BookingOtpService(cfg.JWT_ACCESS_SECRET),
      inject: [CONFIG],
    },
    {
      provide: AuthService,
      useFactory: (db: Db, otp: OtpService, cfg: Config) => new AuthService(db, otp, cfg),
      inject: [DB, OtpService, CONFIG],
    },
    { provide: CatalogService, useFactory: (db: Db) => new CatalogService(db), inject: [DB] },
    { provide: OffersService, useFactory: (db: Db) => new OffersService(db), inject: [DB] },
    { provide: StatsService, useFactory: (db: Db) => new StatsService(db), inject: [DB] },
    { provide: SearchService, useFactory: (db: Db) => new SearchService(db), inject: [DB] },
    { provide: ReviewsService, useFactory: (db: Db) => new ReviewsService(db), inject: [DB] },
    { provide: PanchangService, useFactory: (db: Db) => new PanchangService(db), inject: [DB] },

    {
      /*
       * Real storage when it is configured, in-memory otherwise — the same pattern
       * as the gateway below. `loadConfig` refuses to boot production without the
       * credentials, so the fallback can only be reached in development and tests.
       */
      provide: 'OBJECT_STORE',
      useFactory: (cfg: Config): ObjectStore =>
        (cfg.R2_ENDPOINT && cfg.R2_BUCKET && cfg.R2_ACCESS_KEY_ID && cfg.R2_SECRET_ACCESS_KEY
          ? new S3ObjectStore({
            endpoint: cfg.R2_ENDPOINT, bucket: cfg.R2_BUCKET,
            accessKeyId: cfg.R2_ACCESS_KEY_ID, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY,
          })
          : new InMemoryObjectStore()),
      inject: [CONFIG],
    },
    {
      provide: 'GATEWAY',
      useFactory: (cfg: Config): PaymentGateway =>
        cfg.RAZORPAY_KEY_ID && cfg.RAZORPAY_KEY_SECRET && cfg.RAZORPAY_WEBHOOK_SECRET
          ? new RazorpayClient(cfg.RAZORPAY_KEY_ID, cfg.RAZORPAY_KEY_SECRET, cfg.RAZORPAY_WEBHOOK_SECRET)
          // Only reachable outside production - loadConfig() refuses to boot a
          // production process without real credentials.
          : new FakeGateway(),
      inject: [CONFIG],
    },
    {
      provide: PaymentsService,
      useFactory: (db: Db, gw: PaymentGateway, bookings: BookingService) =>
        new PaymentsService(db, gw, bookings),
      inject: [DB, 'GATEWAY', BookingService],
    },
    {
      provide: PayoutService,
      useFactory: (db: Db, ledger: LedgerService) => new PayoutService(db, ledger),
      inject: [DB, LedgerService],
    },
    {
      provide: 'CHANNELS',
      useFactory: (cfg: Config): { primary: Channel; fallback?: Channel } => {
        const primary: Channel = cfg.WHATSAPP_API_URL && cfg.WHATSAPP_API_KEY
          ? new WhatsAppChannel(cfg.WHATSAPP_API_URL, cfg.WHATSAPP_API_KEY, cfg.WHATSAPP_SENDER ?? '')
          : new ConsoleChannel();
        const fallback = cfg.MSG91_AUTH_KEY
          ? new SmsChannel(cfg.MSG91_AUTH_KEY, cfg.MSG91_SENDER_ID)
          : undefined;
        return fallback ? { primary, fallback } : { primary };
      },
      inject: [CONFIG],
    },
    {
      provide: NotificationService,
      useFactory: (db: Db, ch: { primary: Channel; fallback?: Channel }) =>
        new NotificationService(db, ch.primary, ch.fallback),
      inject: [DB, 'CHANNELS'],
    },
    {
      provide: NotificationConsumer,
      useFactory: (db: Db, outbox: OutboxService, notify: NotificationService) =>
        new NotificationConsumer(db, outbox, notify),
      inject: [DB, OutboxService, NotificationService],
    },
    {
      provide: AvailabilityService,
      useFactory: (db: Db, cfg: Config) => new AvailabilityService(db, cfg.BOOKING_HORIZON_DAYS),
      inject: [DB, CONFIG],
    },
    {
      provide: PricingService,
      useFactory: (db: Db, catalog: CatalogService) => new PricingService(db, catalog),
      inject: [DB, CatalogService],
    },
    {
      provide: BookingService,
      useFactory: (
        db: Db, pricing: PricingService, catalog: CatalogService,
        avail: AvailabilityService, slots: SlotService, ledger: LedgerService,
        outbox: OutboxService, otp: BookingOtpService, kv: KvStore, cfg: Config,
        search: SearchService,
      ) => new BookingService(
        db, pricing, catalog, avail, slots, ledger, outbox, otp, kv,
        cfg.BOOKING_HORIZON_DAYS,
        // Bound rather than passed as the service, so BookingService depends on the
        // capability and not on SearchService's own graph.
        { matchPandit: (a) => search.matchPandit(a as never) },
        cfg.OTP_DEV_BYPASS,
      ),
      inject: [
        DB, PricingService, CatalogService, AvailabilityService, SlotService,
        LedgerService, OutboxService, BookingOtpService, KV, CONFIG, SearchService,
      ],
    },

    {
      provide: APP_GUARD,
      useFactory: (auth: AuthService, reflector: Reflector) => new JwtAuthGuard(auth, reflector),
      inject: [AuthService, Reflector],
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    /*
     * Opt-in per route via @Cacheable; anything unmarked stays uncached.
     *
     * `useFactory` with an explicit `inject`, not `useClass`. This package compiles
     * without `emitDecoratorMetadata`, so Nest cannot read constructor parameter
     * types — `useClass` handed the interceptor an undefined Reflector and every
     * route 500'd on `getAllAndOverride`. `APP_GUARD` above is wired the same way
     * for the same reason.
     */
    {
      provide: APP_INTERCEPTOR,
      useFactory: (reflector: Reflector) => new CacheHeaderInterceptor(reflector),
      inject: [Reflector],
    },
  ],
  exports: [CONFIG, DB, KV],
})
export class AppModule {}
