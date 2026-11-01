import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { PurohitController } from '../purohit.controller';
import { InMemoryObjectStore } from '../../storage/object-store';

/**
 * The auto-accept toggle.
 *
 * THE BUG THIS ENDPOINT FIXES. The dashboard has advised purohits to "turn on
 * auto-accept" since the dashboard shipped, linking to a page fragment that was
 * never a control for it. `pandit_profiles.auto_accept` (ADR 0011) has existed the
 * whole time with nothing able to set it. This is the first test that proves it can
 * actually be turned on.
 *
 * A dedicated endpoint rather than a field on `PUT /profile`, which overwrites every
 * column `ProfileInput` names on every call — folding this in would mean an unrelated
 * profile edit could silently reset it.
 */
let h: Harness;
let ctl: PurohitController;

beforeEach(async () => {
  h = await makeHarness();
  ctl = new PurohitController(
    h.db, null as never, null as never, new InMemoryObjectStore(), null as never,
  );
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

const stored = async () => {
  const rows = await h.db.execute(sql`
    SELECT auto_accept FROM pandit_profiles WHERE user_id = ${h.ids.panditId}`);
  return ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
    auto_accept: boolean;
  }>;
};

describe('PATCH auto-accept', () => {
  it('is off by default, matching the schema', async () => {
    expect((await stored())[0]!.auto_accept).toBe(false);
  });

  it('turns it on and returns the new value', async () => {
    const res = await ctl.setAutoAccept({ sub: h.ids.panditId } as never, { enabled: true });
    expect(res).toEqual({ autoAccept: true });
    expect((await stored())[0]!.auto_accept).toBe(true);
  });

  it('turns it back off', async () => {
    await ctl.setAutoAccept({ sub: h.ids.panditId } as never, { enabled: true });
    await ctl.setAutoAccept({ sub: h.ids.panditId } as never, { enabled: false });
    expect((await stored())[0]!.auto_accept).toBe(false);
  });

  /**
   * The whole reason this is a separate endpoint: an unrelated profile write must
   * never touch it.
   */
  it('survives an unrelated profile save', async () => {
    await ctl.setAutoAccept({ sub: h.ids.panditId } as never, { enabled: true });

    await ctl.saveProfile({ sub: h.ids.panditId } as never, {
      experienceYears: 12,
      languages: ['bn'],
      traditions: ['smarta'],
      serviceRadiusKm: 15,
      baseLat: 22.57,
      baseLng: 88.36,
    });

    expect((await stored())[0]!.auto_accept).toBe(true);
  });

  it('rejects a non-boolean body rather than coercing it', async () => {
    await expect(ctl.setAutoAccept(
      { sub: h.ids.panditId } as never, { enabled: 'yes' },
    )).rejects.toThrow();
  });
});
