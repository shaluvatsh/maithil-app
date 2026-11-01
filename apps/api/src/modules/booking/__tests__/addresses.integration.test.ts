import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { makeHarness, type Harness } from '../../../test/harness';
import { cities, addresses } from '../../../db/schema/index';
import { BookingReadController } from '../booking-read.controller';
import { GeocodeService } from '../geocode.service';

let h: Harness;
let ctl: BookingReadController;

beforeEach(async () => {
  h = await makeHarness();
  // The geocoder IS on this path — every saved address resolves to a point.
  ctl = new BookingReadController(h.db, null as never, new GeocodeService(h.db));
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

const asDevotee = () => ({ sub: h.ids.devoteeId } as never);

/**
 * THE BUG THIS COVERS.
 *
 * `addresses` stores `city_id`, and this endpoint was a bare
 * `select().from(addresses)` — so it answered with `cityId` and no `city`, while
 * both of its consumers believed otherwise:
 *
 * - The account page declared `city: string` on its row type and rendered
 *   `{a.city}`, which was `undefined` for every row ever returned. A saved address
 *   read "7 Lake Road, Gariahat ·  700029", with a separator and a gap in it.
 * - `/book` filled the same hole with `{region.name.en}` — the city selected in the
 *   HEADER, not the city the address is in. A devotee with a flat in Kolkata and
 *   parents in Delhi saw both addresses labelled with whichever city they had
 *   picked, and the label CHANGED when they switched city, without the address
 *   having moved. That is the precise failure the multi-city rule in
 *   CONTRIBUTING.md names: never format a city's data with another city's rules.
 *
 * Neither consumer could have been right, because the data they needed was not in
 * the response. So the fix is in the read model, and this is what holds it there.
 */
describe('a saved address carries its own city', () => {
  it('returns the city name and slug, not a bare city_id', async () => {
    const list = await ctl.addresses(asDevotee());

    expect(list.length).toBeGreaterThan(0);
    const row = list[0]!;
    expect(row.city).toBe('Kolkata');
    expect(row.citySlug).toBe('kolkata');
    // The raw foreign key is of no use to a client and is not worth shipping.
    expect(row).not.toHaveProperty('cityId');
  });

  /**
   * The case that makes this load-bearing rather than cosmetic: two addresses in
   * two cities, where any single "current city" label is wrong for one of them.
   */
  it('labels each address with ITS city when a devotee has several', async () => {
    const delhiId = ulid();
    await h.db.insert(cities).values({
      id: delhiId, slug: 'delhi', name: 'Delhi', defaultPanjikaSchool: 'gupta_press',
    } as never);
    await h.db.insert(addresses).values({
      id: ulid(), userId: h.ids.devoteeId, label: "Ma's place",
      line1: '4 Hauz Khas', cityId: delhiId, pincode: '110016',
      lat: 28.55, lng: 77.2, geoPrecision: 'pincode',
    } as never);

    const list = await ctl.addresses(asDevotee());
    const byLabel = new Map(list.map((a) => [a.label, a.city]));

    expect(byLabel.get("Ma's place")).toBe('Delhi');
    // The seeded Kolkata address is untouched by the Delhi one existing.
    expect([...byLabel.values()]).toContain('Kolkata');
  });

  it("never returns another devotee's addresses", async () => {
    const list = await ctl.addresses({ sub: h.ids.panditId } as never);
    expect(list).toEqual([]);
  });
});

/**
 * `POST me/addresses` answered with `returning()`, which is the TABLE — so it had
 * the same hole as the GET, and both callers add the row it returns straight into
 * the list they are already showing. The one address a devotee had just typed was
 * therefore the only one with no city against it, until something forced a refetch.
 */
describe('a newly saved address comes back in the same shape as a listed one', () => {
  it('resolves the posted slug to a city name in its response', async () => {
    const saved = await ctl.addAddress(asDevotee(), {
      label: 'Office', line1: '9 Camac Street', citySlug: 'kolkata', pincode: '700017',
    });

    expect(saved.city).toBe('Kolkata');
    expect(saved.citySlug).toBe('kolkata');
    expect(saved).not.toHaveProperty('cityId');
    // Not the devotee's own id echoed back; it is their list already.
    expect(saved).not.toHaveProperty('userId');
  });

  it('matches the listed row field for field, so no placeholder needs correcting', async () => {
    const saved = await ctl.addAddress(asDevotee(), {
      label: 'Office', line1: '9 Camac Street', citySlug: 'kolkata', pincode: '700017',
    });
    const listed = (await ctl.addresses(asDevotee())).find((a) => a.id === saved.id);

    expect(listed).toBeDefined();
    expect(Object.keys(saved).sort()).toEqual(Object.keys(listed!).sort());
  });

  it('rejects a city that is not in the catalogue rather than inventing one', async () => {
    await expect(ctl.addAddress(asDevotee(), {
      line1: '1 Nowhere Lane', citySlug: 'atlantis', pincode: '700017',
    })).rejects.toThrow(/atlantis/);
  });
});
