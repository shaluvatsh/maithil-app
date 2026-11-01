import { Controller, Get, Post, Patch, Body, Param, Query, Inject } from '@nestjs/common';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { DB } from '../../common/tokens';
import type { Db } from '../../db/client';
import { ulid } from 'ulid';
import { bookings, bookingEvents, users, rituals, ritualTranslations, ledgerEntries, ledgerAccounts, panditProfiles, addresses, cities, reviews } from '../../db/schema/index';
import { CurrentUser, Roles } from '../auth/guards';
import type { JwtClaims } from '../auth/auth.service';
import { BookingService } from './booking.service';
import { GeocodeService } from './geocode.service';
import { PayoutService } from '../payouts/payouts.service';
import { DomainError, ErrorCode, PanjikaSchool } from '@themaithil/contracts';

/**
 * `locale` is a Postgres enum, so an arbitrary `?locale=` string cannot reach the query.
 * Anything unrecognised falls back to English rather than erroring — a bad locale in a
 * URL should not stop someone seeing their bookings.
 */
/**
 * A pincode is the one field worth validating hard: it drives the service-area
 * check and it is the field people fat-finger. Everything else is free text,
 * because Indian addresses do not fit a schema.
 */
const AddressInput = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  line1: z.string().trim().min(4).max(200),
  line2: z.string().trim().max(200).optional(),
  citySlug: z.string().trim().min(2).max(60),
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'a pincode is six digits'),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

/**
 * `setPanjika` took `{ school }` unvalidated, so an arbitrary string reached a
 * Postgres enum column and 500'd instead of a clean 422.
 *
 * The first fix hand-wrote the three values it knew about, which then drifted a
 * second time the moment the enum grew to six: a devotee in Bangalore or Tamil Nadu
 * could not set `vikram_banaras`, `tamil_vakya` or `drik_generic` even though the
 * contract, the pg enum and `packages/region` all accepted them. Deriving the schema
 * from `PanjikaSchool` means there is no second list to keep in step.
 */
const PanjikaInput = z.object({
  school: PanjikaSchool.nullable(),
});

const LOCALES = ['en', 'bn', 'hi'] as const;
type Locale = (typeof LOCALES)[number];
const asLocale = (v: unknown): Locale =>
  (LOCALES as readonly string[]).includes(v as string) ? (v as Locale) : 'en';

/** Read models for the UI, plus a dev-only hook that stands in for the PSP webhook. */
@Controller('v1')
export class BookingReadController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BookingService) private readonly bookingService: BookingService,
    @Inject(GeocodeService) private readonly geocode: GeocodeService,
  ) {}

  /**
   * `locale` defaults to English rather than Bengali.
   *
   * This join was pinned to 'bn', so a devotee in Pune saw their booking history in
   * Bengali script. The catalogue is pan-India; only the launch city is Bengali.
   * Preferred locale first, English as the fallback, slug as the last resort.
   */
  private base(locale: Locale = 'en') {
    const preferred = alias(ritualTranslations, 'preferred_translation');
    const english = alias(ritualTranslations, 'english_translation');
    const pandit = alias(users, 'pandit_user');

    return this.db.select({
      id: bookings.id,
      state: bookings.state,
      date: bookings.date,
      slotIdx: bookings.slotIdx,
      slotSpan: bookings.slotSpan,
      slotStartAt: bookings.slotStartAt,
      slotEndAt: bookings.slotEndAt,
      price: bookings.price,
      paymentMode: bookings.paymentMode,
      samagriOption: bookings.samagriOption,
      panjikaSchool: bookings.panjikaSchool,
      cashCollectedPaise: bookings.cashCollectedPaise,
      devoteeId: bookings.devoteeId,
      panditId: bookings.panditId,
      addressId: bookings.addressId,
      // Assigned at draft creation (ADR 0012), so this is never null by the
      // time a booking exists - the devotee is told who is coming, not left
      // reading a raw purohit id once they leave the confirmation screen.
      panditName: pandit.name,
      panditPhone: pandit.phone,
      ritualName: sql<string>`coalesce(${preferred.name}, ${english.name}, ${rituals.slug})`
        .as('ritual_name'),
      ritualSlug: rituals.slug,
      deliveryMode: rituals.deliveryMode,
      /*
       * How a REMOTE booking is actually delivered. Null on an at-home puja, which
       * is most of them — the purohit is travelling to the family, so there is
       * nothing to join and nothing to record.
       */
      joinUrl: bookings.joinUrl,
      recordingUrl: bookings.recordingUrl,
      createdAt: bookings.createdAt,
      acceptDeadlineAt: bookings.acceptDeadlineAt,
    })
      .from(bookings)
      .innerJoin(rituals, eq(rituals.id, bookings.ritualId))
      .innerJoin(pandit, eq(pandit.id, bookings.panditId))
      .leftJoin(preferred, and(
        eq(preferred.ritualId, bookings.ritualId),
        eq(preferred.locale, locale),
      ))
      .leftJoin(english, and(
        eq(english.ritualId, bookings.ritualId),
        eq(english.locale, 'en'),
      ));
  }

  /**
   * Sets the family's panjika. Asked once, at first run, in the devotee's own words -
   * not buried in settings. It is snapshotted onto each booking, so changing it later
   * never rewrites history. See ADR 0003.
   */
  @Patch('me/panjika')
  async setPanjika(@CurrentUser() user: JwtClaims, @Body() raw: unknown) {
    const body = PanjikaInput.parse(raw);
    await this.db.update(users)
      .set({ panjikaSchool: body.school })
      .where(eq(users.id, user.sub));
    return { panjikaSchool: body.school };
  }

  /** The devotee's saved venues. Needed before a booking can be drafted. */
  /**
   * Returns each address WITH ITS OWN CITY, which `select()` could not.
   *
   * `addresses` stores `city_id`, so a bare `select().from(addresses)` returned
   * `cityId` and no `city` — while both consumers believed otherwise. The account
   * page declared `city: string` on its row type and rendered `{a.city}`, which was
   * `undefined` on every row: a saved address read "7 Lake Road, Gariahat ·  700029",
   * with a separator and a gap where the city belonged. `/book` papered over the
   * same hole with `{region.name.en}` — the city currently selected in the HEADER,
   * not the city the address is in — so a devotee with a flat in Kolkata and
   * parents in Delhi saw both labelled with whichever one they had picked, which is
   * the exact failure the multi-city rule in CONTRIBUTING.md names ("never format a
   * city's data with another city's rules").
   *
   * `citySlug` comes back too, because that is the key the rest of the product
   * speaks: `getRegion(slug)` on the web side keys off it, so a caller that wants
   * this address's money or slot format can get it right without a second lookup.
   */
  @Get('me/addresses')
  async addresses(@CurrentUser() user: JwtClaims) {
    return this.db.select({
      id: addresses.id,
      label: addresses.label,
      line1: addresses.line1,
      line2: addresses.line2,
      pincode: addresses.pincode,
      lat: addresses.lat,
      lng: addresses.lng,
      geoPrecision: addresses.geoPrecision,
      city: cities.name,
      citySlug: cities.slug,
      createdAt: addresses.createdAt,
    }).from(addresses)
      .innerJoin(cities, eq(cities.id, addresses.cityId))
      .where(eq(addresses.userId, user.sub))
      .orderBy(desc(addresses.createdAt));
  }

  /**
   * Saves a new venue.
   *
   * This endpoint did not exist, so `addresses` had exactly one row — the demo
   * devotee's, written by `db:seed:dev`. Anyone who registered their own account
   * reached the end of the booking flow and hit "no saved address", with no way
   * anywhere in the product to add one.
   */
  @Post('me/addresses')
  async addAddress(@CurrentUser() user: JwtClaims, @Body() body: unknown) {
    const input = AddressInput.parse(body);
    const city = await this.catalogCity(input.citySlug);
    /*
     * Exact coordinate if the devotee shared one, else their pincode's centroid,
     * else the city's - and the address records WHICH, because travel time is
     * derived from this point (ADR 0013) and a city centroid makes the distance
     * between two addresses exactly zero. See GeocodeService.
     */
    const point = await this.geocode.resolve({
      citySlug: input.citySlug,
      pincode: input.pincode,
      lat: input.lat,
      lng: input.lng,
    });

    const row = (await this.db.insert(addresses).values({
      id: ulid(),
      userId: user.sub,
      label: input.label ?? 'Home',
      line1: input.line1,
      line2: input.line2 ?? null,
      cityId: city.id,
      pincode: input.pincode,
      lat: point.lat,
      lng: point.lng,
      geoPrecision: point.precision,
    }).returning())[0]!;

    /*
     * Shaped like a row from the GET above, city name included.
     *
     * `returning()` gives back the TABLE, so this answered with `cityId` and no
     * `city` — and both callers add the new row straight into the list they are
     * already showing. The one address a devotee had just typed was therefore the
     * one with no city against it, until a refetch replaced it. Returning the same
     * shape means the optimistic row and the refetched row are identical.
     */
    const { cityId: _cityId, userId: _userId, ...rest } = row;
    return { ...rest, city: city.name, citySlug: city.slug };
  }

  /**
   * The city a slug names, or a clean 404.
   *
   * Returns the NAME as well as the id — one more column from a row already being
   * read, and without it `addAddress` cannot answer in the same shape as
   * `GET me/addresses` without a second round trip for a string it just looked up.
   */
  private async catalogCity(slug: string): Promise<{ id: string; name: string; slug: string }> {
    const row = (await this.db.select({ id: cities.id, name: cities.name, slug: cities.slug })
      .from(cities).where(eq(cities.slug, slug)).limit(1))[0];
    if (!row) throw new DomainError(ErrorCode.NOT_FOUND, `unknown city: ${slug}`);
    return row;
  }

  @Get('bookings')
  async mine(@CurrentUser() user: JwtClaims, @Query('locale') locale?: string) {
    const col = user.role === 'pandit' ? bookings.panditId : bookings.devoteeId;
    return this.base(asLocale(locale))
      .where(eq(col, user.sub)).orderBy(desc(bookings.createdAt)).limit(50);
  }

  /**
   * Everything a single-booking view needs, in one call: the booking, the
   * purohit's public profile (experience, languages, chanting sample - fields
   * the LIST view has no use for, so they stay off `base()` and are joined
   * here only), and the full event timeline.
   */
  @Get('bookings/:id')
  async detail(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    const rows = await this.base().where(eq(bookings.id, id)).limit(1);
    const b = rows[0];
    if (!b) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');
    const isParty = b.devoteeId === user.sub || b.panditId === user.sub;
    if (!isParty && user.role !== 'admin' && user.role !== 'ops') {
      throw new DomainError(ErrorCode.FORBIDDEN, 'not your booking');
    }
    // Which side the caller reviews as, if any - an admin/ops viewer is neither.
    const authorRole = b.devoteeId === user.sub ? 'devotee' : b.panditId === user.sub ? 'pandit' : null;
    const [timeline, profile, myReview, venue] = await Promise.all([
      this.db.select().from(bookingEvents)
        .where(eq(bookingEvents.bookingId, id)).orderBy(bookingEvents.at),
      this.db.select({
        experienceYears: panditProfiles.experienceYears,
        languages: panditProfiles.languages,
        traditions: panditProfiles.traditions,
        chantingSampleUrl: panditProfiles.chantingSampleUrl,
        chantingSampleLabel: panditProfiles.chantingSampleLabel,
      }).from(panditProfiles).where(eq(panditProfiles.userId, b.panditId)).limit(1),
      authorRole
        ? this.db.select({ id: reviews.id }).from(reviews)
          .where(and(eq(reviews.bookingId, id), eq(reviews.author, authorRole))).limit(1)
        : Promise.resolve([]),
      /*
       * Where the purohit is actually going. The booking has carried an
       * `addressId` since it was drafted and no read model ever returned it, so
       * the one screen whose whole job is answering "what did I book" could not
       * answer the most basic question a family asks the morning of a ceremony -
       * and the purohit's own job card could not either.
       */
      // Null for a remote service, which genuinely has no venue - so this is
      // "there is nowhere to go", not "we failed to look it up".
      b.addressId
        ? this.db.select({
          label: addresses.label, line1: addresses.line1, line2: addresses.line2,
          pincode: addresses.pincode, lat: addresses.lat, lng: addresses.lng,
        }).from(addresses).where(eq(addresses.id, b.addressId)).limit(1)
        : Promise.resolve([]),
    ]);
    // `state === 'reviewed'` is not "you reviewed it" - the 72-hour one-sided
    // publish (reviews.service.ts publishExpired) flips a booking to `reviewed`
    // off a single side's review, so the devotee's own submission can only be
    // known by checking whether their row actually exists.
    return {
      ...b,
      timeline,
      panditProfile: profile[0] ?? null,
      myReviewSubmitted: myReview.length > 0,
      venue: venue[0] ?? null,
    };
  }

  /**
   * Purohit job inbox: anything awaiting them or already on their calendar.
   *
   * UNBOUNDED, FOUND IN REVIEW. `completed` never leaves this filter and carried no
   * limit and no date bound, so this grew with the purohit's entire career — a
   * purohit two years in with a thousand finished pujas paid for all thousand rows
   * on every visit to the one page the product itself calls daily use. Worse,
   * plain ascending `slotStartAt` order put that entire history BEFORE any
   * upcoming job, so a new request could be sorted below months of old completions
   * instead of near the top where it is actionable.
   *
   * Fixed the same way `mine()` below already is — a cap — plus a priority tier so
   * the cap, if it ever bites, discards old completions rather than truncating the
   * handful of jobs that are actually awaiting this purohit right now. Active jobs
   * sort soonest-first (what to do next); completed ones sort most-recent-first
   * (the ones actually still worth seeing).
   */
  @Roles('pandit')
  @Get('me/jobs')
  async jobs(@CurrentUser() user: JwtClaims) {
    return this.base()
      .where(and(
        eq(bookings.panditId, user.sub),
        inArray(bookings.state, ['pending_accept', 'confirmed', 'in_progress', 'completed']),
      ))
      .orderBy(
        sql`${bookings.state} = 'completed'`,
        sql`CASE WHEN ${bookings.state} = 'completed' THEN -1 ELSE 1 END * extract(epoch from ${bookings.slotStartAt})`,
      )
      .limit(50);
  }

  /**
   * DEV ONLY. Stands in for the Razorpay webhook until the PSP integration lands,
   * so the whole lifecycle can be exercised from the UI. Guarded by NODE_ENV.
   */
  @Post('dev/bookings/:id/simulate-token-capture')
  async simulateCapture(@Param('id') id: string) {
    if (process.env.NODE_ENV === 'production') {
      throw new DomainError(ErrorCode.FORBIDDEN, 'not available in production');
    }
    return this.bookingService.confirmOnTokenCapture({
      bookingId: id, paymentIntentId: `dev_${id}`,
    });
  }

  /**
   * Pujas this household did last year, coming round again.
   *
   * Almost every ritual here is annual. A family books Lakshmi Puja every Diwali and
   * a shraddha on the same tithi each year, and the product's answer to that was to
   * make them search the catalogue from scratch every time — treating the most
   * predictable demand in the business as if it were a cold visit.
   *
   * Matched on the RITUAL, not the date: the Gregorian anniversary is meaningless
   * here, because the tithi moves. The devotee is told what they booked and when it
   * falls this year, and the panchang decides the date.
   */
  @Get('me/anniversaries')
  async anniversaries(@CurrentUser() user: JwtClaims) {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    // Cutoff computed once, in JS, to match the tz math below rather than mixing a
    // second (UTC) notion of "now" into the query.
    const cutoffDate = new Date(Date.parse(`${today}T00:00:00+05:30`) - 240 * 86_400_000)
      .toISOString().slice(0, 10);

    const rows = await this.db
      .select({
        ritualId: bookings.ritualId,
        slug: rituals.slug,
        name: ritualTranslations.name,
        lastBookedAt: sql<string>`max(${bookings.date})`,
        times: sql<number>`count(*)::int`,
      })
      .from(bookings)
      .innerJoin(rituals, eq(rituals.id, bookings.ritualId))
      .leftJoin(ritualTranslations, and(
        eq(ritualTranslations.ritualId, rituals.id),
        eq(ritualTranslations.locale, 'en'),
      ))
      .where(and(
        eq(bookings.devoteeId, user.sub),
        // Completed only. Suggesting a repeat of a puja that was cancelled — or
        // worse, one we failed to staff — is the platform reminding somebody of a
        // bad experience and calling it a recommendation.
        eq(bookings.state, 'completed'),
      ))
      .groupBy(bookings.ritualId, rituals.slug, ritualTranslations.name)
      /*
       * The "not a recent booking" filter used to run in JS AFTER `.limit(6)` on
       * rows already ordered most-recent-first - so it filtered exactly the six
       * rows LEAST likely to survive it. A devotee with six bookings in the last
       * few months and one genuine two-year-old anniversary saw an empty list,
       * because the real anniversary never made it past the limit to be checked.
       * HAVING runs before LIMIT, so this now excludes recent bookings first and
       * limits what is actually eligible.
       */
      .having(sql`max(${bookings.date}) <= ${cutoffDate}`)
      .orderBy(desc(sql`max(${bookings.date})`))
      .limit(6);

    return rows.map((r) => {
      const days = Math.round(
        (Date.parse(`${today}T00:00:00+05:30`) - Date.parse(`${r.lastBookedAt}T00:00:00+05:30`))
        / 86_400_000,
      );
      return {
        slug: r.slug,
        name: r.name ?? r.slug,
        lastBookedOn: r.lastBookedAt,
        daysSince: days,
        times: Number(r.times),
        /** Roughly a year, with a month either side for the tithi drifting. */
        dueNow: days >= 305,
      };
    });
  }
}

const AdminQuery = z.object({ state: z.string().optional() });

@Controller('v1/admin')
@Roles('admin', 'ops')
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PayoutService) private readonly payouts: PayoutService,
  ) {}

  /**
   * Who has been paid and who has not.
   *
   * The `ledger` endpoint below returns raw double-entry rows. Those are the truth
   * and they are the wrong shape for the one question ops actually asks about money
   * — "is this purohit settled?" — which answering from them meant summing four
   * entry types across two directions, per purohit, by hand.
   *
   * Payouts are run by hand from this console rather than on a schedule, which is a
   * deliberate choice while volumes are small. That makes this screen the control
   * surface for it: without a view of what is outstanding, running payouts manually
   * means guessing who is due.
   */
  @Get('settlements')
  settlements() {
    return this.payouts.settlementOverview();
  }

  @Get('bookings')
  async board(@Query() raw: unknown) {
    const q = AdminQuery.parse(raw);
    /*
     * The console selected `rituals.slug` and rendered it raw, so ops read
     * "griha-prabesh" and "durga-puja-ghot" while every other surface — the
     * devotee's bookings, the purohit's job list — showed "Griha Pravesh" and
     * "Durga Puja (Kalash Sthapana, at home)". Staff had to hold a second set of
     * names for the same rituals, and none of the catalogue's naming reached the
     * one place people look when a devotee rings up about a booking.
     *
     * Same join and same coalesce as `base()` above, pinned to English: the
     * console is an internal tool and does not follow the viewer's locale.
     */
    const english = alias(ritualTranslations, 'english_translation');
    const rows = await this.db.select({
      id: bookings.id, state: bookings.state, date: bookings.date,
      slotStartAt: bookings.slotStartAt, price: bookings.price,
      paymentMode: bookings.paymentMode, ritualSlug: rituals.slug,
      ritualName: sql<string>`coalesce(${english.name}, ${rituals.slug})`.as('ritual_name'),
      devoteeName: sql<string>`dev.name`, devoteePhone: sql<string>`dev.phone`,
      panditPhone: sql<string>`pan.phone`, panditName: sql<string>`pan.name`,
    })
      .from(bookings)
      .innerJoin(rituals, eq(rituals.id, bookings.ritualId))
      .leftJoin(english, and(
        eq(english.ritualId, bookings.ritualId),
        eq(english.locale, 'en'),
      ))
      .innerJoin(sql`users AS dev`, sql`dev.id = ${bookings.devoteeId}`)
      .innerJoin(sql`users AS pan`, sql`pan.id = ${bookings.panditId}`)
      .where(q.state ? eq(bookings.state, q.state as never) : sql`true`)
      .orderBy(desc(bookings.createdAt)).limit(200);
    return rows;
  }

  @Get('pandits')
  async pandits() {
    return this.db.select({
      id: users.id, name: users.name, phone: users.phone,
      kycStatus: panditProfiles.kycStatus,
      experienceYears: panditProfiles.experienceYears,
      ratingCount: panditProfiles.ratingCount,
      cashJobsEnabled: panditProfiles.cashJobsEnabled,
      languages: panditProfiles.languages,
    })
      .from(panditProfiles)
      .innerJoin(users, eq(users.id, panditProfiles.userId))
      .limit(200);
  }

  /** The ledger, with the balance check the whole design rests on. */
  @Get('ledger')
  async ledger() {
    const entries = await this.db.select({
      id: ledgerEntries.id, txnId: ledgerEntries.txnId, bookingId: ledgerEntries.bookingId,
      direction: ledgerEntries.direction, amountPaise: ledgerEntries.amountPaise,
      type: ledgerEntries.type, at: ledgerEntries.at,
      ownerType: ledgerAccounts.ownerType, ownerId: ledgerAccounts.ownerId,
    })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .orderBy(desc(ledgerEntries.at)).limit(300);

    const drift = await this.db.execute(sql`
      SELECT txn_id FROM ledger_entries GROUP BY txn_id
       HAVING SUM(CASE WHEN direction='debit' THEN amount_paise ELSE 0 END)
           <> SUM(CASE WHEN direction='credit' THEN amount_paise ELSE 0 END)`);
    const unbalanced = ((drift as unknown as { rows?: unknown[] }).rows ?? drift) as unknown[];

    return { entries, unbalancedTransactions: unbalanced.length };
  }
}