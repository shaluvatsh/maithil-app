import { Module, Global } from '@nestjs/common';
import { APP_GUARD, APP_FILTER, Reflector } from '@nestjs/core';
import { createDb, type Db } from './db/client';
import { loadConfig, type Config } from './common/config';
import { MemoryKv, RedisKv, type KvStore } from './common/kv';
import { DomainExceptionFilter } from './common/http-errors';
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
import { CatalogController } from './modules/catalog/catalog.controller';
import { AvailabilityService } from './modules/availability/availability.service';
import { PricingService } from './modules/booking/pricing.service';
import { BookingService } from './modules/booking/booking.service';
import { BookingController } from './modules/booking/booking.controller';

export const CONFIG = Symbol('CONFIG');
export const DB = Symbol('DB');
export const KV = Symbol('KV');

/**
 * Single Nest module for now. The bounded contexts are enforced by folder structure
 * and lint boundaries rather than by Nest modules - splitting into feature modules
 * buys ceremony, not isolation, until there is a second team. See ADR 0001.
 */
@Global()
@Module({
  controllers: [AuthController, CatalogController, BookingController],
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
      ) => new BookingService(
        db, pricing, catalog, avail, slots, ledger, outbox, otp, kv,
        cfg.BOOKING_HORIZON_DAYS, cfg.OTP_DEV_BYPASS,
      ),
      inject: [
        DB, PricingService, CatalogService, AvailabilityService, SlotService,
        LedgerService, OutboxService, BookingOtpService, KV, CONFIG,
      ],
    },

    {
      provide: APP_GUARD,
      useFactory: (auth: AuthService, reflector: Reflector) => new JwtAuthGuard(auth, reflector),
      inject: [AuthService, Reflector],
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
  exports: [CONFIG, DB, KV],
})
export class AppModule {}
