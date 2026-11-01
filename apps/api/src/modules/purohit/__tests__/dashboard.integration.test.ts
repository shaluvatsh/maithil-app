import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { DashboardService } from '../dashboard.service';
import { PayoutService } from '../../payouts/payouts.service';
import { LedgerService } from '../../../domain/ledger';
import { ErrorCode } from '@themaithil/contracts';

/**
 * The purohit dashboard.
 *
 * Two of these tests exist to stop a specific harm rather than a bug:
 *
 *   - the cohort must stay ANONYMOUS, so it is suppressed below a floor. With four
 *     peers, "you are below the median" names one of them.
 *   - a purohit who DECLINED a booking must never be told they were outranked on it.
 *     That is both wrong and insulting, and it is the mistake the obvious query makes.
 */
interface Ctx {
  h: Harness; svc: DashboardService; pandit: string; peers: string[];
  /** A real booking, because `match_decisions.booking_id` is a foreign key. */
  bookingId: string;
  /** Mutable, so a test can grant endorsements without a community fixture. */
  endorsed: { count: number };
}

async function setup(): Promise<Ctx> {
  const h = await makeHarness();
  const payouts = new PayoutService(h.db, new LedgerService(h.db));
  const endorsed = { count: 0 };
  const svc = new DashboardService(
    h.db,
    { preview: (id) => payouts.preview(id) },
    // The community context is bound as a capability, so it can be a counter here.
    { endorsedAnswers: async () => endorsed.count },
    { horizonDays: 120, demandWindowDays: 90 },
  );
  /*
   * A real booking row. `match_decisions` references it, deliberately — a decision
   * that cannot be traced to the booking it produced explains nothing.
   */
  const bookingId = ulid();
  await h.db.execute(sql`
    INSERT INTO bookings (id, devotee_id, pandit_id, ritual_id, city_id, date,
                          slot_idx, slot_span, slot_start_at, slot_end_at,
                          state, panjika_school, price, payment_mode)
    VALUES (${bookingId}, ${h.ids.devoteeId}, ${h.ids.panditId}, ${h.ids.ritualId},
            ${h.ids.cityId}, '2026-12-01', 0, 1,
            '2026-12-01T00:30:00Z', '2026-12-01T03:30:00Z',
            'confirmed', 'gupta_press', '{}'::jsonb, 'cash')`);

  return { h, svc, pandit: h.ids.panditId, peers: [], bookingId, endorsed };
}

/** Verified peers in the same city, which is what the cohort is drawn from. */
async function addPeers(c: Ctx, n: number) {
  for (let i = 0; i < n; i++) {
    const id = ulid();
    c.peers.push(id);
    await c.h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id, name)
      VALUES (${id}, ${`+9198300006${20 + i}`}, 'pandit', ${c.h.ids.cityId}, ${`Peer ${i}`})`);
    await c.h.db.execute(sql`
      INSERT INTO pandit_profiles (user_id, kyc_status, experience_years,
                                   rating_sum, rating_count, acceptance_rate)
      VALUES (${id}, 'verified', ${5 + i}, ${20 + i}, 5, ${(0.5 + i * 0.1).toFixed(4)})`);
  }
}

/** A recorded allocation, as `matchPandit` would have written it. */
const decision = (c: Ctx, args: {
  chosen: string | null; candidates: Array<{ panditId: string; declined?: boolean }>;
}) => c.h.db.execute(sql`
  INSERT INTO match_decisions (id, booking_id, ritual_id, chosen_pandit_id,
                               chosen_score, weights, candidates)
  VALUES (${ulid()}, ${c.bookingId}, ${c.h.ids.ritualId}, ${args.chosen},
          '0.71', '{"rating":0.4}'::jsonb,
          ${JSON.stringify(args.candidates.map((x) => ({
            panditId: x.panditId, score: 0.7, declined: x.declined ?? false,
          })))}::jsonb)`);

let c: Ctx;
beforeEach(async () => { c = await setup(); });
afterEach(async () => { await c?.h.pg.close(); });

describe('standing is their own, never a ranking', () => {
  it('returns the raw rating and count, not the smoothed ranking number', async () => {
    await c.h.db.execute(sql`
      UPDATE pandit_profiles SET rating_sum = 43, rating_count = 9
       WHERE user_id = ${c.pandit}`);
    const d = await c.svc.forPandit(c.pandit);
    // 43/9 = 4.78. The Bayesian prior belongs to the matcher, not to this screen.
    expect(d.standing.rating).toBe(4.8);
    expect(d.standing.ratingCount).toBe(9);
  });

  it('says nothing about rating before there are any reviews', async () => {
    const d = await c.svc.forPandit(c.pandit);
    expect(d.standing.rating).toBeNull();
    expect(d.standing.ratingCount).toBe(0);
  });

  it('surfaces the new-supply boost, because it runs out', async () => {
    const d = await c.svc.forPandit(c.pandit);
    // A purohit who thinks this work rate is normal concludes the platform turned
    // against them when the boost expires.
    expect(d.standing.newSupplyBoostRemaining).toBeGreaterThan(0);
  });

  it('refuses an account with no purohit profile', async () => {
    await expect(c.svc.forPandit(c.h.ids.devoteeId))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});

describe('the cohort is anonymous or it is absent', () => {
  it('is suppressed while the city is too small to hide anyone', async () => {
    await addPeers(c, 2);
    const d = await c.svc.forPandit(c.pandit);
    expect(d.cohort.suppressed).toBe(true);
    expect(d.cohort.medianAcceptance).toBeNull();
    expect(d.cohort.medianRating).toBeNull();
  });

  it('reports medians once the cohort is large enough', async () => {
    await addPeers(c, 6);
    const d = await c.svc.forPandit(c.pandit);
    expect(d.cohort.suppressed).toBe(false);
    expect(d.cohort.size).toBeGreaterThanOrEqual(5);
    expect(d.cohort.medianAcceptance).toBeGreaterThan(0);
  });

  it('never names another purohit anywhere in the payload', async () => {
    await addPeers(c, 6);
    const d = await c.svc.forPandit(c.pandit);
    const json = JSON.stringify(d);
    // The whole argument against a leaderboard, asserted rather than assumed.
    for (const peer of c.peers) expect(json).not.toContain(peer);
    expect(json).not.toContain('Peer 0');
  });
});

describe('allocation explains the work', () => {
  it('counts what they were offered', async () => {
    await decision(c, { chosen: c.pandit, candidates: [{ panditId: c.pandit }] });
    await decision(c, { chosen: c.pandit, candidates: [{ panditId: c.pandit }] });
    const d = await c.svc.forPandit(c.pandit);
    expect(d.allocation.offered).toBe(2);
    expect(d.allocation.nearMiss).toBe(0);
  });

  it('counts a near miss when someone else won', async () => {
    await addPeers(c, 1);
    await decision(c, {
      chosen: c.peers[0]!,
      candidates: [{ panditId: c.peers[0]! }, { panditId: c.pandit }],
    });
    const d = await c.svc.forPandit(c.pandit);
    expect(d.allocation.nearMiss).toBe(1);
    expect(d.allocation.offered).toBe(0);
  });

  /**
   * The distinction that matters. A booking they turned down is not one they were
   * outranked on, and telling them otherwise is the obvious query's mistake.
   */
  it('never calls a decline a near miss', async () => {
    await addPeers(c, 1);
    await decision(c, {
      chosen: c.peers[0]!,
      candidates: [{ panditId: c.peers[0]! }, { panditId: c.pandit, declined: true }],
    });
    const d = await c.svc.forPandit(c.pandit);
    expect(d.allocation.declinedAway).toBe(1);
    expect(d.allocation.nearMiss).toBe(0);
  });

  it('shows the components of the last decision they featured in', async () => {
    await decision(c, { chosen: c.pandit, candidates: [{ panditId: c.pandit }] });
    const d = await c.svc.forPandit(c.pandit);
    expect(d.allocation.lastScored).not.toBeNull();
    expect(d.allocation.lastScored!.components).toMatchObject({ panditId: c.pandit });
    // The weights are snapshotted, because last month's decision explained with this
    // month's weights is explained wrong.
    expect(d.allocation.lastScored!.weights).toMatchObject({ rating: 0.4 });
  });

  it('is empty rather than broken before anything has been allocated', async () => {
    const d = await c.svc.forPandit(c.pandit);
    expect(d.allocation).toMatchObject({ offered: 0, nearMiss: 0, declinedAway: 0 });
    expect(d.allocation.lastScored).toBeNull();
  });
});

describe('money, and the limits nobody has ever been shown', () => {
  it('reports cash headroom against the limit', async () => {
    const d = await c.svc.forPandit(c.pandit);
    // Default limit is ₹5,000 with nothing outstanding.
    expect(d.money.cashLimitPaise).toBe(500000);
    expect(d.money.cashHeadroomPaise).toBe(500000);
  });

  it('warns before the headroom runs out, not after', async () => {
    await c.h.db.execute(sql`
      UPDATE pandit_profiles SET cash_credit_limit_paise = 100000 WHERE user_id = ${c.pandit}`);
    const before = await c.svc.forPandit(c.pandit);
    expect(before.attention.map((a) => a.code)).not.toContain('cash_headroom_low');

    // A limit of ₹1,000 with ₹900 of dues leaves a fifth of the headroom.
    await c.h.db.execute(sql`
      UPDATE pandit_profiles SET cash_credit_limit_paise = 1000 WHERE user_id = ${c.pandit}`);
    const after = await c.svc.forPandit(c.pandit);
    expect(after.money.cashHeadroomPaise).toBeLessThanOrEqual(1000);
  });
});

describe('attention says what is quietly costing them work', () => {
  it('flags paused cash jobs as blocking', async () => {
    await c.h.db.execute(sql`
      UPDATE pandit_profiles SET cash_jobs_enabled = false WHERE user_id = ${c.pandit}`);
    const d = await c.svc.forPandit(c.pandit);
    expect(d.attention).toEqual(expect.arrayContaining([
      { code: 'cash_jobs_paused', severity: 'blocking' },
    ]));
  });

  it('flags unverified KYC as blocking', async () => {
    await c.h.db.execute(sql`
      UPDATE pandit_profiles SET kyc_status = 'submitted' WHERE user_id = ${c.pandit}`);
    const d = await c.svc.forPandit(c.pandit);
    expect(d.attention.map((a) => a.code)).toContain('kyc_incomplete');
  });

  it('suggests auto-accept and a chanting sample as advice, not as faults', async () => {
    const d = await c.svc.forPandit(c.pandit);
    const advice = d.attention.filter((a) => a.severity === 'advice').map((a) => a.code);
    expect(advice).toContain('auto_accept_off');
    expect(advice).toContain('no_chanting_sample');
  });

  it('returns codes, never English sentences', async () => {
    const d = await c.svc.forPandit(c.pandit);
    // A purohit reading Bengali must not be told why their income stopped in English,
    // so the copy is translated client-side from these codes.
    for (const a of d.attention) {
      expect(a.code).toMatch(/^[a-z_]+$/);
    }
  });

  it('says nothing when everything is in order', async () => {
    await c.h.db.execute(sql`
      UPDATE pandit_profiles
         SET kyc_status = 'verified', cash_jobs_enabled = true, auto_accept = true,
             chanting_sample_url = 'https://example.test/a.mp3',
             linked_account_id = 'acc_1'
       WHERE user_id = ${c.pandit}`);
    const d = await c.svc.forPandit(c.pandit);
    expect(d.attention).toEqual([]);
  });
});

describe('demand is disclosed only where it cannot identify a household', () => {
  /** A booking in a named pincode, optionally somebody else's. */
  const bookingIn = async (pincode: string, panditId: string, n = 1) => {
    for (let i = 0; i < n; i++) {
      const addressId = ulid();
      await c.h.db.execute(sql`
        INSERT INTO addresses (id, user_id, line1, city_id, pincode, lat, lng, geo_precision)
        VALUES (${addressId}, ${c.h.ids.devoteeId}, '1 Somewhere', ${c.h.ids.cityId},
                ${pincode}, 22.5, 88.3, 'city')`);
      await c.h.db.execute(sql`
        INSERT INTO bookings (id, devotee_id, pandit_id, ritual_id, city_id, address_id,
                              date, slot_idx, slot_span, slot_start_at, slot_end_at,
                              state, panjika_school, price, payment_mode)
        VALUES (${ulid()}, ${c.h.ids.devoteeId}, ${panditId}, ${c.h.ids.ritualId},
                ${c.h.ids.cityId}, ${addressId}, '2026-12-05', 0, 1,
                '2026-12-05T00:30:00Z', '2026-12-05T03:30:00Z',
                'completed', 'gupta_press', '{}'::jsonb, 'digital_full')`);
    }
  };

  it('withholds a total that would expose too few other households', async () => {
    await addPeers(c, 1);
    // Two bookings, neither theirs. Disclosing "2 in 700029" narrows it to two
    // families in one neighbourhood on one tithi.
    await bookingIn('700029', c.peers[0]!, 2);

    const d = await c.svc.forPandit(c.pandit);
    const area = d.demand.areas.find((a) => a.pincode === '700029')!;
    expect(area.suppressed).toBe(true);
    expect(area.bookings).toBeNull();
    expect(area.yours).toBe(0);
  });

  it('discloses once enough other households are in the bucket', async () => {
    await addPeers(c, 1);
    await bookingIn('700029', c.peers[0]!, 5);
    const d = await c.svc.forPandit(c.pandit);
    const area = d.demand.areas.find((a) => a.pincode === '700029')!;
    expect(area.suppressed).toBe(false);
    expect(area.bookings).toBe(5);
  });

  /**
   * Their own bookings are their own data. Suppressing a bucket that contains only
   * their work would hide their own history from them to protect nobody.
   */
  it('always shows their own work, however few', async () => {
    await bookingIn('700005', c.pandit, 1);
    const d = await c.svc.forPandit(c.pandit);
    const area = d.demand.areas.find((a) => a.pincode === '700005')!;
    expect(area.suppressed).toBe(false);
    expect(area.bookings).toBe(1);
    expect(area.yours).toBe(1);
  });

  it('still reports their own count exactly inside a withheld bucket', async () => {
    await addPeers(c, 1);
    await bookingIn('700091', c.pandit, 1);
    await bookingIn('700091', c.peers[0]!, 2);
    const d = await c.svc.forPandit(c.pandit);
    const area = d.demand.areas.find((a) => a.pincode === '700091')!;
    // Total withheld, own count exact — more useful than hiding the row, and it
    // discloses nothing they did not already know.
    expect(area.bookings).toBeNull();
    expect(area.yours).toBe(1);
  });

  it('orders by demand, so the first row is the one worth acting on', async () => {
    await addPeers(c, 1);
    await bookingIn('700029', c.peers[0]!, 6);
    await bookingIn('700005', c.peers[0]!, 9);
    const d = await c.svc.forPandit(c.pandit);
    expect(d.demand.areas[0]!.pincode).toBe('700005');
  });
});

describe('coverage is never asserted on a distance we did not measure', () => {
  const withCentroid = async (pincode: string, lat: number, lng: number) =>
    c.h.db.execute(sql`
      INSERT INTO pincode_centroids (pincode, lat, lng, source)
      VALUES (${pincode}, ${lat}, ${lng}, 'test')`);

  const bookingAt = async (pincode: string, panditId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const addressId = ulid();
      await c.h.db.execute(sql`
        INSERT INTO addresses (id, user_id, line1, city_id, pincode, lat, lng)
        VALUES (${addressId}, ${c.h.ids.devoteeId}, '1 Somewhere', ${c.h.ids.cityId},
                ${pincode}, 22.5, 88.3)`);
      await c.h.db.execute(sql`
        INSERT INTO bookings (id, devotee_id, pandit_id, ritual_id, city_id, address_id,
                              date, slot_idx, slot_span, slot_start_at, slot_end_at,
                              state, panjika_school, price, payment_mode)
        VALUES (${ulid()}, ${c.h.ids.devoteeId}, ${panditId}, ${c.h.ids.ritualId},
                ${c.h.ids.cityId}, ${addressId}, '2026-12-05', 0, 1,
                '2026-12-05T00:30:00Z', '2026-12-05T03:30:00Z',
                'completed', 'gupta_press', '{}'::jsonb, 'digital_full')`);
    }
  };

  it('says nothing about coverage when the pincode has no centroid', async () => {
    await addPeers(c, 1);
    await bookingAt('700029', c.peers[0]!, 6);
    const d = await c.svc.forPandit(c.pandit);
    const area = d.demand.areas.find((a) => a.pincode === '700029')!;
    // Null, not false. "Outside your radius" on an unmeasured distance would have
    // them widen it for nothing.
    expect(area.distanceKm).toBeNull();
    expect(area.covered).toBeNull();
    expect(d.demand.uncovered).toEqual([]);
  });

  it('flags a busy area outside the radius as the thing to act on', async () => {
    await addPeers(c, 1);
    // The harness purohit is based at 22.5726, 88.3639 with a 15 km radius.
    await withCentroid('700091', 22.8000, 88.3639);
    await bookingAt('700091', c.peers[0]!, 7);

    const d = await c.svc.forPandit(c.pandit);
    const area = d.demand.areas.find((a) => a.pincode === '700091')!;
    expect(area.distanceKm).toBeGreaterThan(15);
    expect(area.covered).toBe(false);
    expect(d.demand.uncovered.map((u) => u.pincode)).toContain('700091');
  });

  it('does not list a withheld area as somewhere to expand into', async () => {
    await addPeers(c, 1);
    await withCentroid('700091', 22.8000, 88.3639);
    await bookingAt('700091', c.peers[0]!, 2);
    const d = await c.svc.forPandit(c.pandit);
    // Two households outside the radius is not a market, and naming it would leak
    // the very count we withheld.
    expect(d.demand.uncovered).toEqual([]);
  });

  it('counts a nearby area as covered', async () => {
    await addPeers(c, 1);
    await withCentroid('700029', 22.5800, 88.3700);
    await bookingAt('700029', c.peers[0]!, 6);
    const d = await c.svc.forPandit(c.pandit);
    const area = d.demand.areas.find((a) => a.pincode === '700029')!;
    expect(area.covered).toBe(true);
  });

  it('reports the radius so the fix can name a number', async () => {
    await addPeers(c, 1);
    await bookingAt('700029', c.peers[0]!, 6);
    const d = await c.svc.forPandit(c.pandit);
    expect(d.demand.serviceRadiusKm).toBe(15);
    expect(d.demand.windowDays).toBe(90);
  });
});

describe('the ladder is derived, and every rung states its cost', () => {
  const rung = (d: Awaited<ReturnType<DashboardService['forPandit']>>, code: string) =>
    d.ladder.find((r) => r.code === code)!;

  it('turns a rung the moment the underlying fact changes, with no job in between', async () => {
    const before = await c.svc.forPandit(c.pandit);
    expect(rung(before, 'chanting_sample').earned).toBe(false);

    await c.h.db.execute(sql`
      UPDATE pandit_profiles SET chanting_sample_url = 'https://example.test/a.mp3'
       WHERE user_id = ${c.pandit}`);

    const after = await c.svc.forPandit(c.pandit);
    // Derived, never stored: `pandit_profiles.badges` is deliberately not written,
    // because a stored badge is the copy that goes stale.
    expect(rung(after, 'chanting_sample').earned).toBe(true);
  });

  it('does not write to the badges column it could have used', async () => {
    await c.svc.forPandit(c.pandit);
    const rows = await c.h.db.execute(sql`
      SELECT badges FROM pandit_profiles WHERE user_id = ${c.pandit}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      badges: unknown[];
    }>;
    expect(list[0]!.badges).toEqual([]);
  });

  it('shows progress on a countable rung and none on a yes/no one', async () => {
    const d = await c.svc.forPandit(c.pandit);
    // "0 of 1" on a yes/no rung reads as a score rather than as a task.
    expect(rung(d, 'verified').progress).toBeNull();
    expect(rung(d, 'ten_pujas').progress).toEqual({ have: 0, need: 10 });
  });

  it('counts completed pujas toward experience and caps the progress', async () => {
    // The harness booking is confirmed, not completed.
    let d = await c.svc.forPandit(c.pandit);
    expect(rung(d, 'ten_pujas').progress).toEqual({ have: 0, need: 10 });

    await c.h.db.execute(sql`
      UPDATE bookings SET state = 'completed', completed_at = now(),
                          payment_mode = 'digital_full'
       WHERE pandit_id = ${c.pandit}`);
    d = await c.svc.forPandit(c.pandit);
    expect(rung(d, 'ten_pujas').progress).toEqual({ have: 1, need: 10 });
    expect(rung(d, 'ten_pujas').earned).toBe(false);
  });

  /**
   * Samagri is rated separately from the purohit, so it earns its own rung — a bad
   * kit must never read as the person's failure.
   */
  it('keeps the samagri rung separate from the rating rung', async () => {
    const d = await c.svc.forPandit(c.pandit);
    expect(rung(d, 'samagri_accurate')).toBeTruthy();
    expect(rung(d, 'well_rated')).toBeTruthy();
    expect(rung(d, 'samagri_accurate').progress).toEqual({ have: 0, need: 3 });
  });

  it('counts only ENDORSED answers toward the community rung', async () => {
    let d = await c.svc.forPandit(c.pandit);
    expect(rung(d, 'community_voice').earned).toBe(false);

    // Anyone can post an answer; a peer putting their name to it is the part that
    // means something. The capability returns endorsements, not posts.
    c.endorsed.count = 3;
    d = await c.svc.forPandit(c.pandit);
    expect(rung(d, 'community_voice').earned).toBe(true);
    expect(rung(d, 'community_voice').progress).toEqual({ have: 3, need: 3 });
  });

  it('returns codes, never English, so the copy can be translated', async () => {
    const d = await c.svc.forPandit(c.pandit);
    for (const r of d.ladder) expect(r.code).toMatch(/^[a-z_]+$/);
    // Every rung the design named is present, so no screen has to invent one.
    expect(d.ladder.map((r) => r.code)).toEqual([
      'verified', 'photo', 'chanting_sample', 'payout_linked', 'cash_enabled',
      'qualification', 'ten_pujas', 'well_rated', 'samagri_accurate', 'community_voice',
    ]);
  });

  it('survives a purohit with nothing done yet', async () => {
    const d = await c.svc.forPandit(c.pandit);
    // The harness purohit is verified and cash-enabled; everything else is unearned,
    // and none of it throws.
    expect(rung(d, 'verified').earned).toBe(true);
    expect(rung(d, 'photo').earned).toBe(false);
    expect(d.ladder.every((r) => typeof r.earned === 'boolean')).toBe(true);
  });
});

describe('work counts what is actually in front of them', () => {
  it('separates today, upcoming and requests awaiting an answer', async () => {
    const d = await c.svc.forPandit(c.pandit);
    expect(d.work).toMatchObject({
      today: expect.any(Number),
      upcoming: expect.any(Number),
      awaitingAccept: expect.any(Number),
      completedThisPeriod: expect.any(Number),
      droppedThisPeriod: expect.any(Number),
    });
    // One confirmed booking in December, so nothing today and one ahead.
    expect(d.work.upcoming).toBe(1);
    // camelCase throughout: no SQL alias may reach a client.
    expect(Object.keys(d.work).every((k) => !k.includes('_'))).toBe(true);
  });
});
