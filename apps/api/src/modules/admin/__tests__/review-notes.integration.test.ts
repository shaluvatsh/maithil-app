import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { VerificationController } from '../verification.controller';

let h: Harness;
let ctl: VerificationController;

const asAdmin = () => ({ sub: 'admin_1', role: 'admin' }) as never;

beforeEach(async () => {
  h = await makeHarness();
  ctl = new VerificationController(
    h.db, { record: async () => {} } as never, h.availability as never,
    { presignDownload: async () => 'https://x' } as never,
    h.outbox,
  );
  // `kyc_records.reviewed_by` is a real foreign key, so the reviewer must exist.
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id, referral_code)
    VALUES ('admin_1', '+919876500001', 'admin', ${h.ids.cityId}, 'ADMIN1')`);
  await h.db.execute(sql`UPDATE pandit_profiles SET kyc_status='submitted'
                          WHERE user_id = ${h.ids.panditId}`);
  for (const [id, type] of [['d_id', 'identity'], ['d_pan', 'pan']] as const) {
    await h.db.execute(sql`
      INSERT INTO kyc_records (id, pandit_id, type, status, provider, doc_key)
      VALUES (${id}, ${h.ids.panditId}, ${type}::kyc_type, 'pending', 'manual', ${`kyc/x/${id}`})`);
  }
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

const notesById = async () => {
  const r = await h.db.execute(sql`
    SELECT id, review_notes FROM kyc_records WHERE pandit_id = ${h.ids.panditId}`);
  type Row = { id: string; review_notes: string | null };
  const rows = (((r as { rows?: Row[] }).rows ?? r) as Row[]);
  return Object.fromEntries(rows.map((x) => [x.id, x.review_notes]));
};

/**
 * A rejected purohit has to be told WHICH document to replace.
 *
 * `reviewNotes` was written to every `kyc_records` row for the purohit, so "the PAN
 * is illegible" appeared under their photo ID, their address proof and their
 * certificate alike — and saying which one is wrong is the note's only job.
 */
describe('review notes belong to the document they describe', () => {
  it('puts a per-document note on that document alone', async () => {
    await ctl.decide(asAdmin(), h.ids.panditId, {
      decision: 'rejected', documentNotes: { d_pan: 'the PAN is illegible' },
    });
    const notes = await notesById();
    expect(notes.d_pan).toBe('the PAN is illegible');
    expect(notes.d_id, 'a note about the PAN was stamped onto the photo ID').toBeNull();
  });

  /** A note about the application as a whole still applies to all of it. */
  it('still records a blanket note across the application', async () => {
    await ctl.decide(asAdmin(), h.ids.panditId, {
      decision: 'rejected', notes: 'name does not match across documents',
    });
    const notes = await notesById();
    expect(new Set(Object.values(notes))).toEqual(
      new Set(['name does not match across documents']));
  });

  /** The specific note wins where both are given. */
  it('lets a document note override the blanket one', async () => {
    await ctl.decide(asAdmin(), h.ids.panditId, {
      decision: 'rejected',
      notes: 'please re-send',
      documentNotes: { d_pan: 'the PAN is illegible' },
    });
    const notes = await notesById();
    expect(notes.d_pan).toBe('the PAN is illegible');
    expect(notes.d_id).toBe('please re-send');
  });

  /** The decision itself still applies to every document. */
  it('applies the decision to the whole application', async () => {
    await ctl.decide(asAdmin(), h.ids.panditId, {
      decision: 'rejected', documentNotes: { d_pan: 'illegible' },
    });
    const r = await h.db.execute(sql`
      SELECT DISTINCT status::text AS s FROM kyc_records WHERE pandit_id = ${h.ids.panditId}`);
    const rows = ((r as { rows?: Array<{ s: string }> }).rows ?? r) as Array<{ s: string }>;
    expect(rows.map((x) => x.s)).toEqual(['rejected']);
  });

  /**
   * The id comes from the request body, so a note must never be writable onto
   * another purohit's document by guessing one.
   */
  it("ignores a document id belonging to someone else", async () => {
    await h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id, referral_code)
      VALUES ('other_p', '+919830007777', 'pandit', ${h.ids.cityId}, 'OTHER')`);
    await h.db.execute(sql`
      INSERT INTO pandit_profiles (user_id, kyc_status) VALUES ('other_p', 'submitted')`);
    await h.db.execute(sql`
      INSERT INTO kyc_records (id, pandit_id, type, status, provider)
      VALUES ('d_other', 'other_p', 'identity', 'pending', 'manual')`);

    await ctl.decide(asAdmin(), h.ids.panditId, {
      decision: 'rejected', documentNotes: { d_other: 'tampered' },
    });

    const r = await h.db.execute(sql`SELECT review_notes FROM kyc_records WHERE id='d_other'`);
    type N = { review_notes: string | null };
    const rows = (((r as { rows?: N[] }).rows ?? r) as N[]);
    expect(rows[0]!.review_notes, "wrote a note onto another purohit's document").toBeNull();
  });
});
