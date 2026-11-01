import { describe, it, expect, beforeEach } from 'vitest';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { PanchangService } from '../panchang.service';
import { festivalsFor, FESTIVALS } from '@themaithil/region';
import { ErrorCode } from '@themaithil/contracts';

/**
 * The festival countdown.
 *
 * Two sources, one list. What these tests are really protecting is the SEPARATION:
 * which festivals a city marks comes from the catalogue in `packages/region`, the
 * dates come per school from a transcription, and neither query knows about the
 * other. Get that wrong and a Chennai reader is counted down to Durga Puja — which
 * is not a crash, just a quietly wrong product in thirteen cities out of fourteen.
 */
interface Ctx { h: Harness; svc: PanchangService; ops: string }

async function setup(): Promise<Ctx> {
  const h = await makeHarness();
  const svc = new PanchangService(h.db);
  const ops = ulid();
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id) VALUES (${ops}, '+919830000800', 'ops', ${h.ids.cityId})`);
  return { h, svc, ops };
}

/** A materialised day, which is all the derived tier needs. */
const day = (c: Ctx, date: string, tithi: string) => c.h.db.execute(sql`
  INSERT INTO panchang_days (id, city_id, school, date, sunrise, sunset,
                             tithi_at_sunrise, nakshatra_at_sunrise)
  VALUES (${ulid()}, ${c.h.ids.cityId}, 'gupta_press', ${date},
          ${`${date}T00:00:00Z`}, ${`${date}T12:30:00Z`}, ${tithi}, 'rohini')`);

let c: Ctx;
beforeEach(async () => { c = await setup(); });

describe('monthly observances are derived, with no transcription at all', () => {
  it('finds Ekadashi, Purnima and Amavasya from the stored tithi', async () => {
    await day(c, '2026-10-01', 'shukla_ekadashi');
    await day(c, '2026-10-02', 'shukla_dwadashi');
    await day(c, '2026-10-05', 'purnima');
    await day(c, '2026-10-20', 'amavasya');

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 45,
    });

    expect(list.map((i) => i.date)).toEqual(['2026-10-01', '2026-10-05', '2026-10-20']);
    expect(list.every((i) => i.kind === 'observance')).toBe(true);
  });

  /**
   * The bug this design replaces.
   *
   * Matching is on the stored `value_key`, never on the displayed label — the label
   * is localised, so an English regex over it finds nothing the moment a reader
   * switches to Bengali, and the observances silently vanish.
   */
  it('finds them just the same when the reader is on Bengali', async () => {
    await c.h.db.execute(sql`
      INSERT INTO panchang_terms (value_key, locale, label)
      VALUES ('purnima', 'bn', 'পূর্ণিমা')`);
    await day(c, '2026-10-05', 'purnima');

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'bn',
      from: '2026-10-01' as never, days: 45,
    });
    expect(list).toHaveLength(1);
    // Found by key, and displayed in the reader's language.
    expect(list[0]!.name).toBe('পূর্ণিমা');
  });

  it('ignores an ordinary tithi rather than listing every day', async () => {
    await day(c, '2026-10-03', 'shukla_saptami');
    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 45,
    });
    expect(list).toHaveLength(0);
  });
});

describe('named festivals are transcribed, never computed', () => {
  it('records a date and counts it down', async () => {
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'durga-puja',
      date: '2026-10-17' as never, endsOn: '2026-10-20' as never, enteredBy: c.ops,
    });

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 45,
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'festival', id: 'durga-puja', name: 'Durga Puja',
      date: '2026-10-17', endsOn: '2026-10-20',
    });
  });

  it('names it in the reader’s language where the catalogue has one', async () => {
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'durga-puja', date: '2026-10-17' as never,
      enteredBy: c.ops,
    });
    const bn = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'bn',
      from: '2026-10-01' as never, days: 45,
    });
    expect(bn[0]!.name).toBe('দুর্গাপূজা');
  });

  it('refuses a festival the catalogue does not know', async () => {
    await expect(c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'not-a-festival',
      date: '2026-10-17' as never, enteredBy: c.ops,
    })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('is empty, not broken, when nothing has been transcribed', async () => {
    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 45,
    });
    expect(list).toEqual([]);
  });
});

describe('the transcription worksheet', () => {
  const sheet = () => c.svc.festivalWorksheet({
    school: 'gupta_press', from: '2026-01-01' as never, to: '2026-12-31' as never,
  });

  it('lists every festival, not only the ones with dates', async () => {
    const w = await sheet();
    // The GAPS are the point: somebody working through a physical panjika needs to
    // see what is left, and a screen showing only what exists cannot tell them.
    expect(w.rows.length).toBe(FESTIVALS.length);
    expect(w.rows.every((r) => r.date === null)).toBe(true);
    expect(w.remaining).toBe(FESTIVALS.length);
  });

  it('fills in what has been transcribed and counts down what is left', async () => {
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'durga-puja',
      date: '2026-10-17' as never, endsOn: '2026-10-20' as never, enteredBy: c.ops,
    });

    const w = await sheet();
    const row = w.rows.find((r) => r.festivalId === 'durga-puja')!;
    expect(row.date).toBe('2026-10-17');
    expect(row.endsOn).toBe('2026-10-20');
    expect(row.id).not.toBeNull();
    expect(w.remaining).toBe(FESTIVALS.length - 1);
  });

  it('carries the day count, so the form knows when to ask for an end date', async () => {
    const w = await sheet();
    expect(w.rows.find((r) => r.festivalId === 'durga-puja')!.days).toBe(4);
    expect(w.rows.find((r) => r.festivalId === 'diwali')!.days).toBe(1);
  });

  it('carries who observes each one, so a transcriber can skip the irrelevant', async () => {
    const w = await sheet();
    // Empty means everywhere we serve — Diwali — versus a regional observance.
    expect(w.rows.find((r) => r.festivalId === 'diwali')!.regions).toEqual([]);
    expect(w.rows.find((r) => r.festivalId === 'pongal')!.regions.length).toBeGreaterThan(0);
  });

  it('is per school, so one almanac’s dates never appear under another', async () => {
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'diwali', date: '2026-11-08' as never,
      enteredBy: c.ops,
    });
    const other = await c.svc.festivalWorksheet({
      school: 'bisuddha_siddhanta', from: '2026-01-01' as never, to: '2026-12-31' as never,
    });
    // ADR 0003's whole premise: the almanacs disagree, so a date is never shared.
    expect(other.rows.find((r) => r.festivalId === 'diwali')!.date).toBeNull();
    expect(other.remaining).toBe(FESTIVALS.length);
  });
});

describe('correcting a date read wrong', () => {
  it('removes the entry so a different date can be entered', async () => {
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'diwali', date: '2026-11-07' as never,
      enteredBy: c.ops,
    });
    let w = await c.svc.festivalWorksheet({
      school: 'gupta_press', from: '2026-01-01' as never, to: '2026-12-31' as never,
    });
    const wrong = w.rows.find((r) => r.festivalId === 'diwali')!;

    /*
     * A delete, not an update: `festival_dates` is unique on (school, festival, date),
     * so an upsert keyed on the date cannot change the date.
     */
    await c.svc.removeFestivalDate(wrong.id!);
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'diwali', date: '2026-11-08' as never,
      enteredBy: c.ops,
    });

    w = await c.svc.festivalWorksheet({
      school: 'gupta_press', from: '2026-01-01' as never, to: '2026-12-31' as never,
    });
    expect(w.rows.find((r) => r.festivalId === 'diwali')!.date).toBe('2026-11-08');
  });

  it('refuses an entry that does not exist', async () => {
    await expect(c.svc.removeFestivalDate(ulid()))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('takes the corrected date out of the countdown and puts the new one in', async () => {
    await day(c, '2026-11-07', 'chaturdashi');
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'diwali', date: '2026-11-07' as never,
      enteredBy: c.ops,
    });
    let list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-11-01' as never, days: 45,
    });
    expect(list.find((i) => i.id === 'diwali')!.date).toBe('2026-11-07');

    const w = await c.svc.festivalWorksheet({
      school: 'gupta_press', from: '2026-01-01' as never, to: '2026-12-31' as never,
    });
    await c.svc.removeFestivalDate(w.rows.find((r) => r.festivalId === 'diwali')!.id!);

    list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-11-01' as never, days: 45,
    });
    expect(list.some((i) => i.id === 'diwali')).toBe(false);
  });
});

describe('observance follows the city, dates follow the school', () => {
  it('never counts a Kolkata reader down to Pongal', async () => {
    // Transcribed against the school, which says nothing about who observes it.
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'pongal', date: '2026-10-18' as never,
      enteredBy: c.ops,
    });
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'durga-puja', date: '2026-10-17' as never,
      enteredBy: c.ops,
    });

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 45,
    });
    expect(list.map((i) => i.id)).toEqual(['durga-puja']);
  });

  it('agrees with the catalogue about who marks what', () => {
    const kolkata = festivalsFor('kolkata').map((f) => f.id);
    const chennai = festivalsFor('chennai').map((f) => f.id);
    expect(kolkata).toContain('durga-puja');
    expect(kolkata).not.toContain('pongal');
    expect(chennai).toContain('pongal');
    expect(chennai).not.toContain('durga-puja');
    // Diwali names no regions, so every city marks it.
    expect(kolkata).toContain('diwali');
    expect(chennai).toContain('diwali');
  });

  it('gives every city something to count down to', () => {
    // A city with an empty catalogue would render a permanently blank card and
    // nothing would say why — the silent regional failure this product keeps hitting.
    for (const slug of ['kolkata', 'chennai', 'mumbai', 'guwahati', 'varanasi']) {
      expect(festivalsFor(slug).length, slug).toBeGreaterThan(0);
    }
  });

  it('keeps every catalogue entry reachable from at least one city', () => {
    const reachable = new Set(
      ['kolkata', 'patna', 'delhi', 'mumbai', 'pune', 'ahmedabad', 'jaipur',
        'lucknow', 'varanasi', 'bhubaneswar', 'guwahati', 'bengaluru', 'chennai',
        'hyderabad'].flatMap((s) => festivalsFor(s).map((f) => f.id)),
    );
    for (const f of FESTIVALS) {
      expect(reachable.has(f.id), `${f.id} is in the catalogue but no city marks it`)
        .toBe(true);
    }
  });
});

describe('a shared date shows the festival, not the tithi that defines it', () => {
  it('puts Kali Puja above the Amavasya it falls on', async () => {
    await day(c, '2026-11-08', 'amavasya');
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'kali-puja', date: '2026-11-08' as never,
      enteredBy: c.ops,
    });

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-11-01' as never, days: 45,
    });
    // Both are true; only one is what the household is marking.
    expect(list.map((i) => i.kind)).toEqual(['festival', 'observance']);
    expect(list[0]!.id).toBe('kali-puja');
  });
});

/**
 * A MONTHLY OBSERVANCE RECURS; THE LIST SHOULD NOT.
 *
 * A notable tithi comes round every lunar month — that is what makes it an
 * observance rather than a festival. The merge emitted one row per matching day, so
 * a three-month window produced Amavasya three times, Krishna Ekadashi three times,
 * and so on. A list headed "what is coming up" read as the same handful of names
 * cycling, which is what a reader reported as "a few pujas are repeated".
 *
 * Measured on the dev database before the fix: a 27 Oct – 31 Jan window returned ten
 * entries, of which four names appeared twice and not one was a named festival.
 */
describe('a recurring observance appears once, as its next occurrence', () => {
  it('collapses repeats of the same tithi across months', async () => {
    // Amavasya three lunar months running, which is simply what Amavasya does.
    await day(c, '2026-10-20', 'amavasya');
    await day(c, '2026-11-18', 'amavasya');
    await day(c, '2026-12-18', 'amavasya');

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 120,
    });

    const amavasyas = list.filter((i) => i.name.toLowerCase().includes('amavasya'));
    expect(amavasyas).toHaveLength(1);
    // The NEXT one, not an arbitrary one.
    expect(amavasyas[0]!.date).toBe('2026-10-20');
  });

  it('still lists different observances separately', async () => {
    await day(c, '2026-10-20', 'amavasya');
    await day(c, '2026-10-05', 'purnima');
    await day(c, '2026-11-18', 'amavasya');

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 120,
    });

    expect(list.map((i) => i.date)).toEqual(['2026-10-05', '2026-10-20']);
  });

  /**
   * Festivals are NOT deduplicated. Each is a specific dated event, and two sharing
   * a name inside one window is a transcription error worth seeing rather than
   * quietly hiding — which is exactly what the worksheet exists to catch.
   */
  it('leaves named festivals alone', async () => {
    await c.svc.recordFestival({
      school: 'gupta_press', festivalId: 'durga-puja',
      date: '2026-10-10' as never, enteredBy: c.ops,
    });

    const list = await c.svc.upcoming({
      citySlug: 'kolkata', school: 'gupta_press', locale: 'en',
      from: '2026-10-01' as never, days: 120,
    });

    expect(list.filter((i) => i.kind === 'festival')).toHaveLength(1);
  });
});
