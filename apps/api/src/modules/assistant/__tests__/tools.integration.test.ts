import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { AssistantTools, type Caller } from '../tools';

let h: Harness;
let tools: AssistantTools;
let drafted: unknown[];

const devotee = (): Caller => ({
  userId: h.ids.devoteeId, role: 'devotee', phone: '+919830000001', locale: 'en',
});
const purohit = (): Caller => ({
  userId: h.ids.panditId, role: 'pandit', phone: '+919830000002', locale: 'en',
});

beforeEach(async () => {
  h = await makeHarness();
  drafted = [];
  tools = new AssistantTools(h.db, {
    bookableTimes: async () => [
      { startsAt: '2026-09-14T06:00:00+05:30', available: true },
      { startsAt: '2026-09-14T06:30:00+05:30', available: false },
    ],
    startDraft: async (a) => { drafted.push(a); return { id: 'bk_draft_1' }; },
    webBaseUrl: 'https://themaithil.in',
  });
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * The assistant reaches real data on behalf of a real person, and the model decides
 * which tool to call and with what. So the boundary that matters is not what the
 * model is *told* it may do — it is what the tools will actually execute.
 *
 * Every test here is the same question asked a different way: can a caller reach
 * something that is not theirs?
 */
describe('a tool only ever reaches the caller’s own data', () => {
  it('lists only the asking devotee’s bookings', async () => {
    await h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id, referral_code)
      VALUES ('other_dev', '+919830008888', 'devotee', ${h.ids.cityId}, 'OTHER')`);
    await h.db.execute(sql`
      INSERT INTO bookings (
        id, devotee_id, pandit_id, ritual_id, city_id, address_id, date,
        slot_idx, slot_span, slot_start_at, slot_end_at, state, panjika_school,
        attendee_count, samagri_option, bom_snapshot, price, payment_mode
      ) VALUES (
        'bk_theirs', 'other_dev', ${h.ids.panditId}, ${h.ids.ritualId}, ${h.ids.cityId},
        ${h.ids.addressId}, '2026-09-20', 1, 1,
        now() + interval '10 days', now() + interval '10 days 2 hours',
        'confirmed', 'gupta_press', 10, 'pandit_brings', '[]'::jsonb,
        '{"totalPaise":100000}'::jsonb, 'cash')`);

    const out = await tools.run(devotee(), 'list_my_bookings', {});
    expect(out.content).not.toContain('theirs');
    expect(out.content).toBe('no bookings');
  });

  it('returns only the asking devotee’s addresses', async () => {
    const out = await tools.run(devotee(), 'my_addresses', {});
    expect(out.content).toContain(h.ids.addressId);

    const other = await tools.run(
      { ...devotee(), userId: 'other_dev' }, 'my_addresses', {},
    );
    expect(other.content).toBe('no saved address — they will need to add one on the website');
  });

  /**
   * The sharpest one. `start_booking` takes an `address_id` the MODEL produced —
   * and the model having seen a list of ids a moment ago is not the same as being
   * unable to name a different one.
   */
  it('refuses to book against an address the caller does not own', async () => {
    await h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id, referral_code)
      VALUES ('other_dev2', '+919830008889', 'devotee', ${h.ids.cityId}, 'O2')`);
    await h.db.execute(sql`
      INSERT INTO addresses (id, user_id, line1, city_id, pincode, lat, lng, geo_precision)
      VALUES ('addr_theirs', 'other_dev2', '9 Someone Else Lane', ${h.ids.cityId},
              '700020', 22.51, 88.36, 'exact')`);

    const out = await tools.run(devotee(), 'start_booking', {
      ritual_slug: 'satyanarayan-puja', date: '2026-09-14',
      starts_at: '2026-09-14T06:00:00+05:30',
      address_id: 'addr_theirs', city_slug: 'kolkata',
    });

    expect(out.isError).toBe(true);
    expect(out.content).toContain('does not belong');
    expect(drafted, 'a draft was created against a stranger’s address').toHaveLength(0);
  });

  it('creates the draft when the address is the caller’s own', async () => {
    const out = await tools.run(devotee(), 'start_booking', {
      ritual_slug: 'satyanarayan-puja', date: '2026-09-14',
      starts_at: '2026-09-14T06:00:00+05:30',
      address_id: h.ids.addressId, city_slug: 'kolkata',
    });
    expect(out.isError).toBeUndefined();
    expect(drafted).toHaveLength(1);
  });

  /** A link to review and pay — never a confirmation. */
  it('hands back a payment link and never claims the booking is confirmed', async () => {
    const out = await tools.run(devotee(), 'start_booking', {
      ritual_slug: 'satyanarayan-puja', date: '2026-09-14',
      starts_at: '2026-09-14T06:00:00+05:30',
      address_id: h.ids.addressId, city_slug: 'kolkata',
    });
    expect(out.content).toContain('https://themaithil.in/book?draft=bk_draft_1');
    expect(out.content.toLowerCase()).not.toContain('confirmed');
  });
});

/**
 * Role separation. A devotee must not be able to move a purohit's calendar, and a
 * purohit must not be able to book on someone's behalf — whatever the model asks for.
 */
describe('purohit tools refuse everyone else', () => {
  for (const tool of ['my_jobs', 'set_working_hours', 'block_time']) {
    it(`refuses ${tool} for a devotee`, async () => {
      const out = await tools.run(devotee(), tool, {
        weekday: 0, starts_at: '06:00', ends_at: '18:00', date: '2026-09-14',
      });
      expect(out.isError).toBe(true);
      expect(out.content).toContain('only available to purohits');
    });
  }

  it('refuses start_booking for a purohit', async () => {
    const out = await tools.run(purohit(), 'start_booking', {
      ritual_slug: 'satyanarayan-puja', date: '2026-09-14',
      starts_at: '2026-09-14T06:00:00+05:30',
      address_id: h.ids.addressId, city_slug: 'kolkata',
    });
    expect(out.isError).toBe(true);
    expect(drafted).toHaveLength(0);
  });

  it('lets a purohit set their own hours', async () => {
    const out = await tools.run(purohit(), 'set_working_hours', {
      weekday: 0, starts_at: '05:00', ends_at: '22:00',
    });
    expect(out.content).toContain('Sunday');

    const r = await h.db.execute(sql`
      SELECT starts_at::text AS s FROM pandit_working_hours
       WHERE pandit_id = ${h.ids.panditId} AND weekday = 0`);
    type S = { s: string };
    const rows = (((r as { rows?: S[] }).rows ?? r) as S[]);
    expect(rows[0]!.s).toBe('05:00:00');
  });

  /**
   * Blocking a day must not silently drop a job someone is expecting. It closes the
   * day to NEW bookings and tells the purohit what is still standing.
   */
  it('closes a day without cancelling what is already booked', async () => {
    await h.db.execute(sql`
      INSERT INTO bookings (
        id, devotee_id, pandit_id, ritual_id, city_id, address_id, date,
        slot_idx, slot_span, slot_start_at, slot_end_at, state, panjika_school,
        attendee_count, samagri_option, bom_snapshot, price, payment_mode
      ) VALUES (
        'bk_standing', ${h.ids.devoteeId}, ${h.ids.panditId}, ${h.ids.ritualId},
        ${h.ids.cityId}, ${h.ids.addressId}, '2026-09-14', 1, 1,
        '2026-09-14T06:00:00+05:30', '2026-09-14T08:00:00+05:30',
        'confirmed', 'gupta_press', 10, 'pandit_brings', '[]'::jsonb,
        '{"totalPaise":100000}'::jsonb, 'cash')`);

    const out = await tools.run(purohit(), 'block_time', { date: '2026-09-14' });
    expect(out.content).toContain('untouched');

    const r = await h.db.execute(sql`
      SELECT state::text AS state FROM bookings WHERE id = 'bk_standing'`);
    type B = { state: string };
    const rows = (((r as { rows?: B[] }).rows ?? r) as B[]);
    expect(rows[0]!.state, 'blocking a day cancelled a confirmed booking').toBe('confirmed');
  });
});

describe('input the model produced is still validated', () => {
  it('rejects a weekday outside 0–6', async () => {
    const out = await tools.run(purohit(), 'set_working_hours', {
      weekday: 9, starts_at: '06:00', ends_at: '18:00',
    });
    expect(out.isError).toBe(true);
  });

  it('rejects a time that is not HH:MM', async () => {
    const out = await tools.run(purohit(), 'set_working_hours', {
      weekday: 1, starts_at: 'morning', ends_at: '18:00',
    });
    expect(out.isError).toBe(true);
  });

  it('rejects a malformed date', async () => {
    expect((await tools.run(purohit(), 'block_time', { date: '14th' })).isError).toBe(true);
  });

  /** An unknown tool name is a bug or an attack, never something to guess at. */
  it('refuses a tool that does not exist', async () => {
    const out = await tools.run(devotee(), 'delete_everything', {});
    expect(out.isError).toBe(true);
  });

  /** A thrown error becomes a message the model can recover from, not a 500. */
  it('turns a failure into a result rather than an exception', async () => {
    const out = await tools.run(devotee(), 'check_times', { ritual_slug: 'x' });
    expect(out.isError).toBe(true);
  });
});

describe('catalogue search', () => {
  it('finds a ritual by name', async () => {
    const out = await tools.run(devotee(), 'find_rituals', { query: 'satyanarayan' });
    expect(out.content).toContain('satyanarayan-puja');
  });

  /** People misspell these constantly; trigram similarity is why this is not exact match. */
  it('finds it despite a misspelling', async () => {
    const out = await tools.run(devotee(), 'find_rituals', { query: 'satyanarain puja' });
    expect(out.content).toContain('satyanarayan-puja');
  });

  it('says so when nothing matches', async () => {
    const out = await tools.run(devotee(), 'find_rituals', { query: 'birthday cake' });
    expect(out.content).toContain('nothing in the catalogue');
  });
});
