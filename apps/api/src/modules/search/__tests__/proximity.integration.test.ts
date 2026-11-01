import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { SearchService } from '../search.service';

let h: Harness;
let search: SearchService;

/** Gariahat, roughly — where the harness devotee's address sits. */
const NEAR = { lat: 22.5148, lng: 88.3639 };
/** ~12 km north-east. */
const FAR = { lat: 22.5800, lng: 88.4200 };

/**
 * Two extra purohits at known distances, otherwise identical: same price, same
 * experience, same (absent) reviews. Distance is then the ONLY thing that can
 * separate them, which is what makes the assertions below mean something.
 */
const addPurohit = async (id: string, at: { lat: number; lng: number }, langs: string[]) => {
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id, referral_code)
    VALUES (${id}, ${`+91983002${id.slice(-4)}`}, 'pandit', ${h.ids.cityId}, ${id})`);
  await h.db.execute(sql`
    INSERT INTO pandit_profiles (user_id, kyc_status, cash_jobs_enabled,
      base_lat, base_lng, experience_years, service_radius_km, languages)
    VALUES (${id}, 'verified', true, ${at.lat}, ${at.lng}, 20, 40,
            ${`{${langs.join(',')}}`}::text[])`);
  await h.db.execute(sql`
    INSERT INTO pandit_rituals (pandit_id, ritual_id, price_paise, active)
    VALUES (${id}, ${h.ids.ritualId}, 150000, true)`);
};

beforeEach(async () => {
  h = await makeHarness();
  search = new SearchService(h.db);
  // Take the harness's own purohit out of the way so only these two compete.
  await h.db.execute(sql`UPDATE pandit_rituals SET active = false
                          WHERE pandit_id = ${h.ids.panditId}`);
  await addPurohit('pandit_near', NEAR, ['bn', 'en']);
  await addPurohit('pandit_far', FAR, ['bn', 'en']);
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

const match = (extra: Record<string, unknown> = {}) => search.matchPandit({
  ritualId: h.ids.ritualId, citySlug: 'kolkata', ...extra,
});

/**
 * Proximity is a quarter of the allocation score and did nothing at all:
 * `createDraft` fetched the address for an ownership check, selected `userId`
 * alone, and passed no coordinates — so `distance_km` was NULL for every candidate
 * and all of them scored the same neutral 0.5, while the booking screen told the
 * devotee they were matched "nearest to you".
 */
describe('the nearest purohit is preferred, when we know where the devotee is', () => {
  it('picks the nearer purohit given an exact address', async () => {
    const picked = await match({ ...NEAR, geoPrecision: 'exact' });
    expect(picked!.id).toBe('pandit_near');
  });

  it('prefers the nearer one from the other side of the city too', async () => {
    const picked = await match({ ...FAR, geoPrecision: 'exact' });
    expect(picked!.id).toBe('pandit_far');
  });

  /**
   * The subtle one, and the reason precision is carried at all.
   *
   * A `city`-precision address is the city centroid — identical for every devotee
   * in Kolkata. Ranking by distance from it would not find anyone's nearest
   * purohit; it would hand every booking in the city to whoever lives closest to
   * the middle. Neutral is the honest answer, so the OTHER terms decide.
   */
  it('ignores a city-centroid coordinate rather than ranking by it', async () => {
    const centroid = { lat: 22.5726, lng: 88.3639, geoPrecision: 'city' };
    const withCity = await search.searchPandits({
      ritualId: h.ids.ritualId, citySlug: 'kolkata', ...centroid,
    });
    const withNothing = await search.searchPandits({
      ritualId: h.ids.ritualId, citySlug: 'kolkata',
    });
    expect(withCity.map((p) => p.id)).toEqual(withNothing.map((p) => p.id));
    expect(withCity.every((p) => p.distanceKm === null)).toBe(true);
  });

  it('still ranks when no coordinate is supplied at all', async () => {
    expect(await match()).not.toBeNull();
  });
});

/**
 * "Matched for your family's vidhi and language" was on the booking screen and in
 * the Terms while `matchPandit` received no language at all.
 */
describe('language is scored, never used to exclude', () => {
  /**
   * Decided between purohits who are otherwise equal — deliberately NOT strong
   * enough to override distance.
   *
   * The bonus is 0.05 against proximity's 0.25, so a purohit who speaks the
   * family's language does not get sent across the city ahead of one next door.
   * It settles the close calls that price and experience were deciding, which on
   * a young roster is most of them. Both purohits sit at the same point here, so
   * language is the only thing left to separate them.
   */
  it('decides between two equally close purohits', async () => {
    await h.db.execute(sql`
      UPDATE pandit_profiles SET base_lat = ${NEAR.lat}, base_lng = ${NEAR.lng}
       WHERE user_id IN ('pandit_near', 'pandit_far')`);
    await h.db.execute(sql`
      UPDATE pandit_profiles SET languages = '{bn}'::text[] WHERE user_id = 'pandit_near'`);
    await h.db.execute(sql`
      UPDATE pandit_profiles SET languages = '{bn,mai}'::text[] WHERE user_id = 'pandit_far'`);

    const picked = await match({ ...NEAR, geoPrecision: 'exact', devoteeLocale: 'mai' });
    expect(picked!.id).toBe('pandit_far');
  });

  /** And it must not outrank distance: a nearer purohit still wins. */
  it('does not send the devotee across the city for a language', async () => {
    await h.db.execute(sql`
      UPDATE pandit_profiles SET languages = '{bn}'::text[] WHERE user_id = 'pandit_near'`);
    await h.db.execute(sql`
      UPDATE pandit_profiles SET languages = '{bn,mai}'::text[] WHERE user_id = 'pandit_far'`);
    const picked = await match({ ...NEAR, geoPrecision: 'exact', devoteeLocale: 'mai' });
    expect(picked!.id).toBe('pandit_near');
  });

  /**
   * The reason it is a bonus and not a filter: a language nobody on the roster
   * speaks must not turn into "no purohit is free", which is a far worse answer
   * for the devotee than someone who speaks their second language.
   */
  it('still returns someone when nobody speaks the language', async () => {
    const picked = await match({ ...NEAR, geoPrecision: 'exact', devoteeLocale: 'ta' });
    expect(picked).not.toBeNull();
  });
});
