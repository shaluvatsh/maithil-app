import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { ulid } from 'ulid';
import { makeHarness, daysFromNow, type Harness } from '../../../test/harness';
import { panchangDays, panchangIntervals, muhuratFlags, panchangTerms } from '../../../db/schema/index';
import { PanchangService } from '../panchang.service';

let h: Harness;
let panchang: PanchangService;
const FROM = daysFromNow(1);

beforeEach(async () => {
  h = await makeHarness();
  panchang = new PanchangService(h.db);
  await h.db.insert(panchangTerms).values([
    { valueKey: 'purnima', locale: 'bn', label: 'পূর্ণিমা' },
    { valueKey: 'rohini', locale: 'bn', label: 'রোহিণী' },
  ]).onConflictDoNothing();
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

describe('panchang materialisation', () => {
  it('writes days, intervals and per-ritual flags', async () => {
    const res = await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 30 });
    expect(res.days).toBe(30);
    expect(res.intervals).toBeGreaterThan(50);   // ~30 tithis + ~30 nakshatras

    const days = await h.db.select().from(panchangDays);
    expect(days).toHaveLength(30);
    expect(days[0]!.school).toBe('bisuddha_siddhanta');
    expect(days[0]!.tithiAtSunrise).toBeTruthy();
    expect(days[0]!.bengaliDate).toMatch(/[০-৯]/);   // Bengali numerals
  });

  it('SATISFIES THE EXCLUSION CONSTRAINT - no two tithis overlap', async () => {
    // The constraint is enforced by Postgres, so a successful insert IS the assertion.
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 60 });
    const tithis = await h.db.select().from(panchangIntervals)
      .where(eq(panchangIntervals.kind, 'tithi'))
      .orderBy(panchangIntervals.startsAt);

    for (let i = 1; i < tithis.length; i++) {
      expect(new Date(tithis[i]!.startsAt).getTime())
        .toBeGreaterThanOrEqual(new Date(tithis[i - 1]!.endsAt).getTime());
    }
  });

  it('is idempotent - re-running does not duplicate or violate constraints', async () => {
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 20 });
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 20 });
    expect(await h.db.select().from(panchangDays)).toHaveLength(20);
  });

  /**
   * Computability is now declared per almanac in region config rather than
   * hardcoded, so this also guards the config: if someone marks a traditional
   * panjika computable, this fails.
   */
  it('refuses to compute an almanac declared non-computable (ADR 0003)', async () => {
    await expect(panchang.materialise({
      citySlug: 'kolkata', from: FROM, days: 5, school: 'gupta_press',
    })).rejects.toThrow(/not computable/);
    await expect(panchang.materialise({
      citySlug: 'kolkata', from: FROM, days: 5, school: 'mithila',
    })).rejects.toThrow(/not computable/);
  });

  it('marks some days auspicious and some not - not a constant', async () => {
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 60 });
    const flags = await h.db.select().from(muhuratFlags)
      .where(eq(muhuratFlags.ritualId, h.ids.ritualId));
    const good = flags.filter((f) => f.isAuspicious).length;
    expect(good).toBeGreaterThan(0);
    expect(good).toBeLessThan(flags.length);
  });

  it('puts sunrise before sunset, every day', async () => {
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 40 });
    const days = await h.db.select().from(panchangDays);
    for (const d of days) {
      expect(new Date(d.sunset).getTime()).toBeGreaterThan(new Date(d.sunrise).getTime());
      expect(new Date(d.abhijitStart!).getTime()).toBeGreaterThan(new Date(d.sunrise).getTime());
      expect(new Date(d.abhijitEnd!).getTime()).toBeLessThan(new Date(d.sunset).getTime());
    }
  });
});

describe('panchang views', () => {
  beforeEach(async () => {
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 30 });
  });

  it('gives the devotee a simple, localised day', async () => {
    const days = await panchang.forDevotee({
      citySlug: 'kolkata', from: FROM, to: daysFromNow(7),
      school: 'bisuddha_siddhanta', locale: 'bn',
    });
    expect(days.length).toBe(7);
    const d = days[0]!;
    expect(d.tithiAtSunrise).toBeTruthy();
    expect(d.abhijit).not.toBeNull();
    expect(d.rahuKaal).not.toBeNull();
    expect(Array.isArray(d.auspiciousForRitualIds)).toBe(true);
  });

  it('gives the purohit the transition times the devotee view hides', async () => {
    const days = await panchang.forPandit({
      citySlug: 'kolkata', from: FROM, to: daysFromNow(3),
      school: 'bisuddha_siddhanta', locale: 'bn',
    });
    expect(days[0]!.intervals.length).toBeGreaterThan(0);
    const tithi = days[0]!.intervals.find((i) => i.kind === 'tithi');
    expect(tithi).toBeDefined();
    expect(new Date(tithi!.endsAt).getTime()).toBeGreaterThan(new Date(tithi!.startsAt).getTime());
  });

  it('annotates slots by real interval intersection', async () => {
    const date = FROM;
    const slots = [0, 1, 2, 3].map((slotIdx) => ({
      slotIdx,
      startsAt: new Date(`${date}T${['06:00', '09:30', '13:00', '16:30'][slotIdx]}:00+05:30`).toISOString(),
      endsAt: new Date(`${date}T${['09:00', '12:30', '16:00', '19:30'][slotIdx]}:00+05:30`).toISOString(),
    }));

    const annotated = await panchang.annotateSlots({
      citySlug: 'kolkata', date, school: 'bisuddha_siddhanta', slots,
    });

    // Abhijit is around solar noon, so exactly one slot should contain it -
    // and it must not be the dawn slot.
    const withAbhijit = annotated.filter((s) => s.containsAbhijit);
    expect(withAbhijit.length).toBeLessThanOrEqual(1);
    expect(annotated[0]!.containsAbhijit).toBe(false);

    // Rahu kaal is one eighth of the day, so it always lands in some slot.
    expect(annotated.some((s) => s.overlapsRahuKaal)).toBe(true);
  });

  it('returns nothing for a school with no data rather than erroring', async () => {
    const days = await panchang.forDevotee({
      citySlug: 'kolkata', from: FROM, to: daysFromNow(7),
      school: 'gupta_press', locale: 'bn',
    });
    expect(days).toEqual([]);
  });

  it('flags a date where the two schools disagree', async () => {
    // Simulate the hand-entered Gupta Press row differing from the computed one.
    const flag = (await h.db.select().from(muhuratFlags).limit(1))[0]!;
    await h.db.insert(muhuratFlags).values({
      id: ulid(), cityId: flag.cityId, school: 'gupta_press',
      date: flag.date, ritualId: flag.ritualId,
      isAuspicious: !flag.isAuspicious, source: 'manual_panjika',
    });

    await panchang.reconcileSchools('kolkata');
    const day = await h.db.select().from(panchangDays)
      .where(and(eq(panchangDays.date, flag.date), eq(panchangDays.school, 'bisuddha_siddhanta')));
    expect(day[0]!.schoolsDisagree).toBe(true);
  });
});

/**
 * The launch city's configured default is Gupta Press, which under ADR 0003 is
 * transcribed by hand and never has been. Both `/panchang` and the home page asked
 * for it, received an empty array, and rendered nothing — the panchang was
 * invisible in Kolkata and the failure was silent, because no rows looks exactly
 * like a quiet month. Clients now ask what is actually published.
 */
describe('which almanacs are published', () => {
  it('reports the computed school as published and the hand-entered one as not', async () => {
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 30 });
    const schools = await panchang.schools('kolkata');

    const bisuddha = schools.find((s) => s.id === 'bisuddha_siddhanta');
    const gupta = schools.find((s) => s.id === 'gupta_press');

    expect(bisuddha?.published).toBe(true);
    expect(bisuddha?.computable).toBe(true);
    expect(bisuddha?.from).toBeTruthy();

    // Declared by the region and offered to the user, but with nothing behind it.
    expect(gupta?.published).toBe(false);
    expect(gupta?.computable).toBe(false);
  });

  it('reports the window each published school covers', async () => {
    await panchang.materialise({ citySlug: 'kolkata', from: FROM, days: 30 });
    const bisuddha = (await panchang.schools('kolkata'))
      .find((s) => s.id === 'bisuddha_siddhanta')!;

    expect(bisuddha.from).toBe(FROM);
    expect(new Date(bisuddha.to!).getTime())
      .toBeGreaterThan(new Date(bisuddha.from!).getTime());
  });

  it('says nothing is published before anything is materialised', async () => {
    const schools = await panchang.schools('kolkata');
    expect(schools.length).toBeGreaterThan(0);
    expect(schools.every((s) => !s.published)).toBe(true);
  });

  /** Driven by the region config, so stray rows never become an offered option. */
  it('returns an empty list for a city that does not exist', async () => {
    expect(await panchang.schools('atlantis')).toEqual([]);
  });
});
