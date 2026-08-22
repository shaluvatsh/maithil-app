import {
  Controller, Get, Post, Put, Patch, Body, Query, Inject,
} from '@nestjs/common';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../../common/tokens';
import type { Db } from '../../db/client';
import {
  users, panditProfiles, panditRituals, rituals, ritualCityPrices, cities, availability,
  slotDefs,
} from '../../db/schema/index';
import { CurrentUser, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import { AvailabilityService } from '../availability/availability.service';
import { DomainError, ErrorCode } from '@themaithil/contracts';
import { isLocale, TRADITION_IDS } from '@themaithil/region';
import type { PaymentGateway } from '../payments/razorpay.client';
import { PayoutAccountInputSchema, storableFields } from './payout-account';

/**
 * Purohit self-service onboarding.
 *
 * None of this existed. A purohit could not sign up, and even given an account by
 * hand they had no way to say what they perform, what they charge, or when they are
 * free — the three things without which they cannot be matched. Supply was seeded
 * by `db:seed:dev` and nothing else, which meant the marketplace only worked for
 * purohits a developer had inserted.
 */
const ProfileInput = z.object({
  bio: z.string().trim().max(1000).optional(),
  experienceYears: z.number().int().min(0).max(80),
  /*
   * Locale CODES, not display names.
   *
   * This accepted any string of 2 to 20 characters, and the two writers of the
   * column disagreed about what to put in it: `db:seed:dev` writes `['bn','hi']`,
   * the onboarding wizard wrote `['Bengali']`. Search matches with an array overlap
   * (`pp.languages && ARRAY[...]`), so a devotee filtering for Bengali matched every
   * seeded purohit and no self-registered one. Two halves of the supply, never
   * comparable, and nothing failed — which is why it survived. Validating against
   * the region package's locale set makes the disagreement impossible to write.
   */
  languages: z.array(z.string().trim().toLowerCase())
    .min(1).max(8)
    .refine((ls) => ls.every(isLocale), {
      message: 'languages must be locale codes such as bn, ta, mr — not display names',
    }),
  traditions: z.array(z.string().trim().toLowerCase())
    .min(1).max(8)
    .refine((ts) => ts.every((t) => TRADITION_IDS.includes(t)), {
      message: 'unknown tradition',
    }),
  serviceRadiusKm: z.number().int().min(1).max(60).default(15),
  baseLat: z.number().min(-90).max(90),
  baseLng: z.number().min(-180).max(180),
  cashJobsEnabled: z.boolean().default(true),
  /**
   * https only — an http URL is blocked as mixed content by every modern browser,
   * so accepting one yields a player that silently never plays.
   */
  chantingSampleUrl: z.string().url().startsWith('https://').max(500).optional(),
  chantingSampleLabel: z.string().trim().max(80).optional(),
  /**
   * Which city they work in.
   *
   * Registration assigns LAUNCH_CITY_SLUG to everyone, and nothing ever asked. A
   * purohit in Mumbai was therefore filed under Kolkata and invisible to every
   * Mumbai devotee — the search joins `cities.slug`, so a wrong city is not a
   * ranking penalty, it is total exclusion.
   */
  citySlug: z.string().trim().min(2).max(60).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const Range = z.object({ from: isoDate, to: isoDate });

const SlotChanges = z.object({
  changes: z.array(z.object({
    date: isoDate,
    slotIdx: z.number().int().min(0).max(7),
    status: z.enum(['open', 'closed']),
  })).min(1).max(200),
});

/**
 * The complete desired week. Anything absent means "not working" — a partial
 * update would make "I no longer work Thursdays" unexpressible.
 */
const WeeklyPattern = z.object({
  pattern: z.array(z.object({
    weekday: z.number().int().min(0).max(6),
    slotIdx: z.number().int().min(0).max(7),
  })).max(56),
});

const ServicesInput = z.object({
  /** Empty is allowed: a purohit narrowing their list to nothing is a pause. */
  services: z.array(z.object({
    ritualId: z.string().min(1),
    pricePaise: z.number().int().min(10000).max(50_000_000),
  })).max(60),
});

@Controller('v1/me/purohit')
@Roles('pandit')
export class PurohitController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
    @Inject('GATEWAY') private readonly gateway: PaymentGateway,
  ) {}

  /**
   * The caller's city, or a clear refusal.
   *
   * Four endpoints opened with the same six lines — select `cityId` from `users`,
   * throw if absent — and `openCalendar` then followed it with a second query
   * selecting `cities.id WHERE cities.id = me.cityId`, which can only ever return
   * the value it was given. Five round trips a request that did not need to exist,
   * and five places to forget the null check the day a fifth endpoint is added.
   */
  private async myCityId(userId: string): Promise<string> {
    const [me] = await this.db.select({ cityId: users.cityId })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (!me?.cityId) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'no city on your account');
    }
    return me.cityId;
  }

  /** Everything the onboarding screen needs, in one call. */
  @Get('profile')
  async profile(@CurrentUser() user: JwtClaims) {
    const [me] = await this.db.select({ cityId: users.cityId, name: users.name })
      .from(users).where(eq(users.id, user.sub)).limit(1);
    const [p] = await this.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, user.sub)).limit(1);

    const mine = await this.db.select({
      ritualId: panditRituals.ritualId, pricePaise: panditRituals.pricePaise,
      active: panditRituals.active,
    }).from(panditRituals).where(eq(panditRituals.panditId, user.sub));

    // The catalogue with the city's price band, so the purohit sets a rate against
    // a reference rather than into a vacuum.
    const catalogue = await this.db.select({
      id: rituals.id, slug: rituals.slug,
      bandMin: ritualCityPrices.bandMinPaise,
      bandMax: ritualCityPrices.bandMaxPaise,
      bandDefault: ritualCityPrices.defaultPaise,
    })
      .from(rituals)
      .innerJoin(ritualCityPrices, and(
        eq(ritualCityPrices.ritualId, rituals.id),
        eq(ritualCityPrices.cityId, me?.cityId ?? ''),
      ))
      .where(eq(rituals.active, true))
      .orderBy(rituals.sortOrder);

    const [currentCity] = me?.cityId
      ? await this.db.select({ slug: cities.slug }).from(cities)
          .where(eq(cities.id, me.cityId)).limit(1)
      : [];

    return {
      name: me?.name ?? null,
      citySlug: currentCity?.slug ?? null,
      profile: p ?? null,
      services: mine,
      catalogue: catalogue.map((c) => ({
        ...c,
        bandMin: Number(c.bandMin), bandMax: Number(c.bandMax),
        bandDefault: Number(c.bandDefault),
      })),
    };
  }

  @Put('profile')
  async saveProfile(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const { citySlug, ...input } = ProfileInput.parse(body);

    if (citySlug) {
      const [city] = await this.db.select({ id: cities.id }).from(cities)
        .where(eq(cities.slug, citySlug)).limit(1);
      if (!city) throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${citySlug}`);
      await this.db.update(users).set({ cityId: city.id })
        .where(eq(users.id, user.sub));
    }

    // Upsert: the row is created at registration, but an OTP-only purohit or one
    // seeded before this endpoint existed may not have one.
    await this.db.insert(panditProfiles).values({
      userId: user.sub, ...input,
      // Never settable from here. Only an admin moves this — see the
      // verification controller.
      kycStatus: 'pending',
    }).onConflictDoUpdate({
      target: panditProfiles.userId,
      set: { ...input },   // note: kycStatus deliberately NOT in the update set
    });

    const [saved] = await this.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, user.sub)).limit(1);
    return saved;
  }

  @Put('services')
  async saveServices(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const { services } = ServicesInput.parse(body);

    const ids = services.map((s) => s.ritualId);
    if (ids.length > 0) {
      const known = await this.db.select({ id: rituals.id }).from(rituals)
        .where(inArray(rituals.id, ids));
      if (known.length !== new Set(ids).size) {
        throw new DomainError(ErrorCode.NOT_FOUND, 'one of those services does not exist');
      }
    }

    return this.db.transaction(async (tx) => {
      // Deactivate rather than delete: a past booking references the row, and
      // price history is worth keeping.
      await tx.update(panditRituals).set({ active: false })
        .where(eq(panditRituals.panditId, user.sub));

      /*
       * One statement, not one per service.
       *
       * This awaited an upsert per row inside the transaction, so a purohit who
       * offers forty rituals held a write transaction open across forty sequential
       * round trips — every one of them blocking the connection, on the screen a
       * new purohit uses during onboarding. Postgres upserts a set as happily as a
       * single row, and `excluded` reads the price from whichever row it collided
       * with, so the update needs no per-row branch.
       */
      if (services.length > 0) {
        await tx.insert(panditRituals)
          .values(services.map((s) => ({
            panditId: user.sub, ritualId: s.ritualId,
            pricePaise: s.pricePaise, active: true,
          })))
          .onConflictDoUpdate({
            target: [panditRituals.panditId, panditRituals.ritualId],
            set: { pricePaise: sql`excluded.price_paise`, active: true },
          });
      }
      return { count: services.length };
    });
  }


  /**
   * The payout destination, as much of it as is safe to show.
   *
   * There is no endpoint that returns an account number because there is no account
   * number to return: it is forwarded to the payment provider when the account is
   * linked and never persisted. A purohit checking "did I give you the right
   * account?" is answered by the last four digits and the IFSC, which is what they
   * would recognise anyway.
   */
  @Get('payout-account')
  async payoutAccount(@CurrentUser() user: JwtClaims) {
    const [p] = await this.db.select({
      method: panditProfiles.payoutMethod,
      holderName: panditProfiles.payoutHolderName,
      last4: panditProfiles.payoutLast4,
      ifsc: panditProfiles.payoutIfsc,
      upiVpa: panditProfiles.payoutUpiVpa,
      linkedAt: panditProfiles.payoutLinkedAt,
      linked: panditProfiles.linkedAccountId,
    }).from(panditProfiles).where(eq(panditProfiles.userId, user.sub)).limit(1);

    return {
      /** The only thing the UI should branch on. A destination exists or it does not. */
      linked: Boolean(p?.linked),
      method: p?.method ?? null,
      holderName: p?.holderName ?? null,
      last4: p?.last4 ?? null,
      ifsc: p?.ifsc ?? null,
      upiVpa: p?.upiVpa ?? null,
      linkedAt: p?.linkedAt ?? null,
    };
  }

  /**
   * Register where a purohit's money goes.
   *
   * `linked_account_id` has existed since the payments client was written and
   * nothing ever set it, because nothing ever asked for an account. `PayoutService`
   * therefore computed a correct net payable with no destination, while the earnings
   * screen promised weekly payouts — the platform could take a devotee's money and
   * had no way to pay the person who did the work.
   *
   * The account number reaches the provider and stops there. Note the ORDER below:
   * the linked account is created FIRST and only a success is written. Persisting
   * our fields before the provider call would leave a profile that looks complete —
   * name, last four, IFSC all present — with `linkedAccountId` still null, which is
   * a purohit who believes they will be paid and will not be.
   */
  @Put('payout-account')
  async savePayoutAccount(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const input = PayoutAccountInputSchema.parse(body);

    const [me] = await this.db.select({ phone: users.phone, email: users.email })
      .from(users).where(eq(users.id, user.sub)).limit(1);
    if (!me) throw new DomainError(ErrorCode.NOT_FOUND, 'account not found');

    const account = await this.gateway.createLinkedAccount({
      method: input.method,
      holderName: input.holderName,
      /*
       * Spread rather than `: undefined`, because `exactOptionalPropertyTypes` treats
       * "absent" and "present and undefined" as different things — and here that
       * distinction is the right one to respect: a UPI payout should not carry an
       * `accountNumber` key at all.
       */
      ...(input.method === 'bank_account'
        ? { accountNumber: input.accountNumber, ifsc: input.ifsc }
        : { vpa: input.vpa }),
      email: me.email ?? `${user.sub}@purohit.themaithil.invalid`,
      phone: me.phone ?? '',
      /*
       * Keyed on the purohit and the destination, so a double-tapped Save creates
       * one linked account rather than two. Two linked accounts for one purohit is
       * not a duplicate row — it is an ambiguity about where their money goes.
       */
      idempotencyKey: `linked-account:${user.sub}:${
        input.method === 'bank_account' ? `${input.ifsc}:${input.accountNumber.slice(-4)}` : input.vpa
      }`,
    });

    await this.db.update(panditProfiles)
      .set({
        ...storableFields(input),
        linkedAccountId: account.id,
        payoutLinkedAt: new Date().toISOString(),
      })
      .where(eq(panditProfiles.userId, user.sub));

    return { linked: true, ...storableFields(input) };
  }

  /**
   * The purohit's own calendar for a window.
   *
   * `AvailabilityService.forRange` and `setSlots` both existed and neither was
   * reachable over HTTP, so a purohit could open their whole calendar in one click
   * and then had no way to close a single afternoon. "Mark me unavailable next
   * Tuesday" is the most common thing a working purohit needs to say, and the only
   * answer the product had was all-or-nothing.
   */
  @Get('availability')
  async calendar(@CurrentUser() user: JwtClaims, @Query() raw: unknown) {
    const q = Range.parse(raw);
    return this.availability.forRange({
      panditId: user.sub, from: q.from as never, to: q.to as never,
    });
  }

  /**
   * Open or close specific slots.
   *
   * Deliberately PATCH over a list rather than PUT of a whole day: a purohit
   * editing Tuesday must not silently overwrite what they set for Wednesday from a
   * stale screen. Booked slots are refused by the service, not by the UI.
   */
  @Patch('availability')
  async setSlots(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const { changes } = SlotChanges.parse(body);

    /*
     * The city is passed so that OPENING a slot can create it.
     *
     * Slots previously only came into existence through `materialise()` — an
     * all-or-nothing "open my whole calendar for 30 days" — so a purohit looking
     * at a date outside that window was told their calendar was not open and given
     * nowhere to open it. Times come from the city's own `slot_defs`, never from
     * the request.
     */
    const updated = await this.availability.setSlots({
      panditId: user.sub, cityId: await this.myCityId(user.sub), changes: changes as never,
    });
    return {
      updated,
      /** Asked for minus applied: anything already booked is reported, not hidden. */
      skipped: changes.length - updated,
    };
  }

  /**
   * The usual working week.
   *
   * Availability is stored per (date, slot) — right for booking, wrong for
   * declaring. "I work Tuesday and Thursday mornings" is one sentence, and saying
   * it through the per-date model meant tapping four slots across thirty days: 120
   * decisions to express one. This is the shift-booking shape every gig platform
   * arrived at for the same reason.
   */
  @Get('weekly-pattern')
  async getWeeklyPattern(@CurrentUser() user: JwtClaims) {
    return this.availability.weeklyPattern(user.sub);
  }

  @Put('weekly-pattern')
  async saveWeeklyPattern(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const { pattern } = WeeklyPattern.parse(body);

    /*
     * Booked slots survive this. Regenerating a calendar from a pattern that has
     * since changed would otherwise release a confirmed puja out from under a
     * devotee — the worst thing this codebase could do — so `setSlots` refuses
     * them and the counts below report only what actually moved.
     */
    return this.availability.setWeeklyPattern({
      panditId: user.sub, cityId: await this.myCityId(user.sub), pattern,
    });
  }

  /**
   * The city's published slot times.
   *
   * The calendar has to be able to offer a slot that does not exist yet, which
   * means it needs the shape of a day before any row for that day has been written.
   */
  @Get('slot-times')
  async slotTimes(@CurrentUser() user: JwtClaims) {
    const cityId = await this.myCityId(user.sub);

    const defs = await this.db.select({
      idx: slotDefs.idx, startTime: slotDefs.startTime, endTime: slotDefs.endTime,
    })
      .from(slotDefs)
      .where(and(eq(slotDefs.cityId, cityId), eq(slotDefs.active, true)))
      .orderBy(slotDefs.idx);

    return defs;
  }

  /**
   * Opens the calendar.
   *
   * Under ADR 0011 a published slot IS a commitment — booking one confirms it
   * outright — so this is the most consequential thing a purohit does, and the
   * screen has to say so.
   */
  @Post('availability')
  async openCalendar(@CurrentUser() user: JwtClaims) {
    await this.availability.materialise({
      panditId: user.sub, cityId: await this.myCityId(user.sub),
    });

    /**
     * Report the TOTAL open, not the number newly written.
     *
     * `materialise` is idempotent — `onConflictDoNothing` — so a second click
     * writes nothing and returned 0. The screen then said "0 slots opened", which
     * reads as failure when it actually means "already open".
     */
    const counted = await this.db.select({
      open: sql<number>`count(*)::int`,
    }).from(availability).where(and(
      eq(availability.panditId, user.sub),
      eq(availability.status, 'open'),
    ));

    return { slotsOpen: counted[0]?.open ?? 0 };
  }
}
