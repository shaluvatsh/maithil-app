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
import { PasswordResetService } from './modules/auth/password-reset.service';
import { JwtAuthGuard } from './modules/auth/guards';
import { AuthController } from './modules/auth/auth.controller';
import { CatalogService } from './modules/catalog/catalog.service';
import { GeocodeService } from './modules/booking/geocode.service';
import { BookableTimesService } from './modules/availability/bookable-times.service';
import { OffersService } from './modules/catalog/offers.service';
import { StatsService } from './modules/catalog/stats.service';
import { CatalogController } from './modules/catalog/catalog.controller';
import { AvailabilityService } from './modules/availability/availability.service';
import { PricingService } from './modules/booking/pricing.service';
import { BookingService } from './modules/booking/booking.service';
import { BookingController } from './modules/booking/booking.controller';
import { HealthController } from './modules/health.controller';
import { PublicConfigController } from './modules/public-config.controller';
import { SearchService } from './modules/search/search.service';
import { PurohitController } from './modules/purohit/purohit.controller';
import { DashboardService } from './modules/purohit/dashboard.service';
import { VerificationController } from './modules/admin/verification.controller';
import { ReviewsController } from './modules/reviews/reviews.controller';
import { ReviewsService } from './modules/reviews/reviews.service';
import { SearchController } from './modules/search/search.controller';
import { BookingReadController, AdminController } from './modules/booking/booking-read.controller';
import { RazorpayClient, FakeGateway, type PaymentGateway } from './modules/payments/razorpay.client';
import { S3ObjectStore, InMemoryObjectStore, type ObjectStore } from './modules/storage/object-store';
import { PurohitKycController } from './modules/purohit/kyc.controller';
import { WhatsAppInboundController } from './modules/assistant/whatsapp.controller';
import { AssistantService, ClaudeModel } from './modules/assistant/assistant.service';
import { AssistantTools } from './modules/assistant/tools';
import { CatalogueKnowledge } from './modules/assistant/knowledge';
import { Conversations } from './modules/assistant/conversations';
import { sql } from 'drizzle-orm';
import { DomainError, ErrorCode } from '@themaithil/contracts';
import { DevUploadsController } from './modules/storage/dev-uploads.controller';
import { PaymentsService } from './modules/payments/payments.service';
import { PaymentsController } from './modules/payments/payments.controller';
import { PayoutService } from './modules/payouts/payouts.service';
import { PayoutController } from './modules/payouts/payouts.controller';
import { NotificationService } from './modules/notifications/notifications.service';
import { NotificationConsumer } from './modules/notifications/notifications.consumer';
import { RefundConsumer } from './modules/payments/refund.consumer';
import { WhatsAppChannel, SmsChannel, ConsoleChannel, type Channel } from './modules/notifications/channels';
import {
  HttpEmailChannel, ConsoleEmailChannel, type EmailChannel,
} from './modules/notifications/email-channel';
import { CommunityService } from './modules/community/community.service';
import { CommunityController } from './modules/community/community.controller';
import {
  CommunityModerationController,
} from './modules/community/moderation.controller';
import { EventsService } from './modules/community/events.service';
import { EventsController } from './modules/community/events.controller';
import { KnowledgeService } from './modules/community/knowledge.service';
import { KnowledgeController } from './modules/community/knowledge.controller';
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
    HealthController, PublicConfigController, AuthController, CatalogController,
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
    // Community (C1 — Ask a Purohit). A separate bounded context: nothing in
    // booking, ledger or payments references it, so it stays droppable. ADR 0014.
    CommunityController,
    // A hold nobody can release is a deletion. ADR 0016.
    CommunityModerationController,
    // Events are not bookings. ADR 0015.
    EventsController,
    // Curated, reviewed, cited. Not posts with a flag. ADR 0014.
    KnowledgeController,
    DevUploadsController,
    WhatsAppInboundController,
  ],
  providers: [
    { provide: CONFIG, useFactory: (): Config => loadConfig() },
    {
      provide: DB,
      useFactory: (cfg: Config): Db => createDb(cfg.DATABASE_URL, cfg.DB_POOL_MAX),
      inject: [CONFIG],
    },
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
      provide: PasswordResetService,
      useFactory: (kv: KvStore, cfg: Config) =>
        new PasswordResetService(kv, cfg.JWT_ACCESS_SECRET),
      inject: [KV, CONFIG],
    },
    {
      /**
       * No email provider has been chosen yet (see docs/PRODUCTION.md), so this
       * degrades the same way WHATSAPP_API_URL/KEY unset degrades `'CHANNELS'`
       * below: a real HTTP send when configured, the console otherwise. Unlike
       * WhatsApp, this is never REQUIRED to boot in production — sign-in does not
       * depend on it, phone OTP always works, so an unconfigured deployment logs
       * reset links instead of emailing them rather than refusing to start.
       */
      provide: 'EMAIL_CHANNEL',
      useFactory: (cfg: Config): EmailChannel =>
        cfg.EMAIL_API_URL && cfg.EMAIL_API_KEY
          ? new HttpEmailChannel(cfg.EMAIL_API_URL, cfg.EMAIL_API_KEY, cfg.EMAIL_FROM ?? '')
          : new ConsoleEmailChannel(),
      inject: [CONFIG],
    },
    {
      provide: AuthService,
      useFactory: (
        db: Db, otp: OtpService, cfg: Config, notify: NotificationService,
        passwordReset: PasswordResetService, mail: EmailChannel,
      ) => new AuthService(db, otp, cfg, notify, passwordReset, mail),
      inject: [DB, OtpService, CONFIG, NotificationService, PasswordResetService, 'EMAIL_CHANNEL'],
    },
    { provide: CatalogService, useFactory: (db: Db) => new CatalogService(db), inject: [DB] },
    { provide: GeocodeService, useFactory: (db: Db) => new GeocodeService(db), inject: [DB] },
    { provide: BookableTimesService, useFactory: (db: Db) => new BookableTimesService(db), inject: [DB] },
    { provide: OffersService, useFactory: (db: Db) => new OffersService(db), inject: [DB] },
    { provide: StatsService, useFactory: (db: Db) => new StatsService(db), inject: [DB] },
    {
      provide: SearchService,
      useFactory: (db: Db, store: ObjectStore) => new SearchService(db, store),
      inject: [DB, 'OBJECT_STORE'],
    },
    { provide: ReviewsService, useFactory: (db: Db) => new ReviewsService(db), inject: [DB] },
    { provide: PanchangService, useFactory: (db: Db) => new PanchangService(db), inject: [DB] },
    {
      provide: DashboardService,
      useFactory: (db: Db, payouts: PayoutService, cfg: Config) =>
        /*
         * Takes the payout CAPABILITY, not the whole service graph — the dashboard
         * needs one read from it and nothing else, and `preview()` is already the
         * unlocked read the earnings screen uses.
         */
        new DashboardService(
          db,
          { preview: (id) => payouts.preview(id) },
          {
            /*
             * One fact from the community context, bound as a capability.
             *
             * The ladder's `community_voice` rung counts answers a PEER endorsed, not
             * answers posted — anyone can write one, and somebody else putting their
             * name to it is the part that means anything. Passed as a function rather
             * than read directly so ADR 0014 holds: the community tables stay
             * droppable, and the purohit dashboard does not reference them.
             */
            endorsedAnswers: async (panditId: string) => {
              const rows = await db.execute(sql`
                SELECT count(*)::int AS n
                  FROM community_post_endorsements e
                  JOIN community_posts p ON p.id = e.post_id
                 WHERE p.author_id = ${panditId} AND p.state = 'published'`);
              const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as
                Array<{ n: number }>;
              return list[0]?.n ?? 0;
            },
          },
          {
            horizonDays: cfg.BOOKING_HORIZON_DAYS,
            demandWindowDays: cfg.PUROHIT_DEMAND_WINDOW_DAYS,
          },
        ),
      inject: [DB, PayoutService, CONFIG],
    },
    {
      provide: KnowledgeService,
      useFactory: (db: Db, store: ObjectStore, cfg: Config) => new KnowledgeService(
        db,
        { mediaUrl: (key) => store.presignDownload({ key }) },
        { pageSize: cfg.COMMUNITY_FEED_PAGE_SIZE },
      ),
      inject: [DB, 'OBJECT_STORE', CONFIG],
    },
    {
      provide: EventsService,
      useFactory: (db: Db, kv: KvStore, cfg: Config) => new EventsService(db, kv, {
        holdTtlSeconds: cfg.COMMUNITY_HOLD_TTL_SECONDS,
        freeOverbookBps: cfg.COMMUNITY_FREE_EVENT_OVERBOOK_BPS,
        pageSize: cfg.COMMUNITY_FEED_PAGE_SIZE,
      }),
      inject: [DB, KV, CONFIG],
    },
    {
      provide: CommunityService,
      useFactory: (db: Db, cfg: Config, store: ObjectStore, audit: AuditService) =>
        new CommunityService(
        db,
        {
          feedPageSize: cfg.COMMUNITY_FEED_PAGE_SIZE,
          askAfterHours: cfg.COMMUNITY_TRUST_ASK_AFTER_HOURS,
          grievanceAckHours: cfg.COMMUNITY_GRIEVANCE_ACK_HOURS,
          grievanceResolveDays: cfg.COMMUNITY_GRIEVANCE_RESOLVE_DAYS,
        },
        {
          /*
           * Bound as a CAPABILITY, not as BookingService.
           *
           * Community needs exactly one fact from the marketplace — has this person
           * ever completed a booking — and taking the service to get it would pull
           * the whole booking graph into a context that is supposed to be
           * droppable. One query, stated here, keeps the arrow pointing outward:
           * community knows nothing about bookings, and booking knows nothing about
           * community. ADR 0014, and the same shape as `matchPandit` below.
           */
          hasCompletedBooking: async (userId: string) => {
            const rows = await db.execute(sql`
              SELECT 1 FROM bookings
               WHERE devotee_id = ${userId}
                 AND state IN ('completed', 'reviewed')
               LIMIT 1`);
            const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as unknown[];
            return list.length > 0;
          },
          avatarUrl: (key: string) => store.presignDownload({ key }),
        },
        audit,
      ),
      inject: [DB, CONFIG, 'OBJECT_STORE', AuditService],
    },

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
          // Real HTTP URLs pointing back at this process, because a browser cannot
          // PUT to a made-up scheme — see the store's own note.
          : new InMemoryObjectStore(`http://localhost:${cfg.PORT}`)),
      inject: [CONFIG],
    },
    { provide: Conversations, useFactory: (db: Db) => new Conversations(db), inject: [DB] },
    {
      provide: AssistantTools,
      useFactory: (db: Db, times: BookableTimesService, bookings: BookingService, cfg: Config) => {
        /*
         * The tools speak in SLUGS; the services take ids and a duration.
         *
         * That is the right split rather than an inconvenience: a slug is stable,
         * readable, and something the model can carry through a conversation without
         * inventing, whereas a ulid is 26 characters of entropy it would sooner or
         * later get wrong. Resolution belongs here, at the edge, where a slug that
         * does not exist becomes one clear error.
         */
        const resolve = async (slug: string) => {
          const rows = await db.execute(sql`
            SELECT id, duration_min FROM rituals WHERE slug = ${slug} AND active LIMIT 1`);
          type R = { id: string; duration_min: number };
          const list = (((rows as { rows?: R[] }).rows ?? rows) as R[]);
          const r = list[0];
          if (!r) throw new DomainError(ErrorCode.NOT_FOUND, `no such service: ${slug}`);
          return r;
        };

        return new AssistantTools(db, {
          bookableTimes: async (a) => {
            const r = await resolve(a.ritualSlug);
            return times.forDate({
              ritualId: r.id, citySlug: a.citySlug, date: a.date,
              durationMin: r.duration_min,
            });
          },
          startDraft: async (a) => {
            const r = await resolve(a.ritualSlug);
            return bookings.createDraft({
              devoteeId: a.userId, citySlug: a.citySlug,
              ritualId: r.id, addressId: a.addressId, date: a.date,
              startsAt: a.startsAt,
              // Sensible middles, and every one of them visible to the devotee on
              // the review screen before they pay — this creates a draft, not a
              // commitment.
              samagriOption: 'pandit_brings', paymentMode: 'cash', attendeeCount: 10,
            } as never);
          },
          webBaseUrl: cfg.WEB_BASE_URL ?? 'https://themaithil.in',
        });
      },
      inject: [DB, BookableTimesService, BookingService, CONFIG],
    },
    {
      provide: AssistantService,
      useFactory: (db: Db, tools: AssistantTools, cfg: Config) =>
        new AssistantService(
          /*
           * No key means the assistant is OFF, not broken. Every entry point checks
           * `enabled` and declines politely, so a deployment without a key still
           * serves the rest of the product rather than 500ing on a webhook.
           */
          cfg.ANTHROPIC_API_KEY ? new ClaudeModel(cfg.ANTHROPIC_API_KEY) : null,
          tools,
          new CatalogueKnowledge(db),
        ),
      inject: [DB, AssistantTools, CONFIG],
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
      useFactory: (db: Db, gw: PaymentGateway, bookings: BookingService, cfg: Config) =>
        new PaymentsService(db, gw, bookings, cfg.PAYMENTS_ENABLED),
      inject: [DB, 'GATEWAY', BookingService, CONFIG],
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
      provide: RefundConsumer,
      useFactory: (db: Db, outbox: OutboxService, payments: PaymentsService) =>
        new RefundConsumer(db, outbox, payments),
      inject: [DB, OutboxService, PaymentsService],
    },
    {
      provide: AvailabilityService,
      useFactory: (db: Db, cfg: Config) => new AvailabilityService(db, cfg.BOOKING_HORIZON_DAYS),
      inject: [DB, CONFIG],
    },
    {
      provide: PricingService,
      useFactory: (db: Db, catalog: CatalogService, cfg: Config) =>
        new PricingService(db, catalog, cfg.PAYMENTS_ENABLED),
      inject: [DB, CatalogService, CONFIG],
    },
    {
      provide: BookingService,
      useFactory: (
        db: Db, pricing: PricingService, catalog: CatalogService,
        avail: AvailabilityService, slots: SlotService, ledger: LedgerService,
        outbox: OutboxService, otp: BookingOtpService, kv: KvStore, cfg: Config,
        search: SearchService, notify: NotificationService, store: ObjectStore,
      ) => new BookingService(
        db, pricing, catalog, avail, slots, ledger, outbox, otp, kv,
        cfg.BOOKING_HORIZON_DAYS,
        // Bound rather than passed as the service, so BookingService depends on the
        // capability and not on SearchService's own graph.
        { matchPandit: (a) => search.matchPandit(a as never) },
        notify,
        store,
        cfg.OTP_DEV_BYPASS,
        cfg.PAYMENTS_ENABLED,
      ),
      inject: [
        DB, PricingService, CatalogService, AvailabilityService, SlotService,
        LedgerService, OutboxService, BookingOtpService, KV, CONFIG, SearchService,
        NotificationService, 'OBJECT_STORE',
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
