import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { VerificationController } from '../verification.controller';
import { PurohitKycController } from '../../purohit/kyc.controller';
import { InMemoryObjectStore } from '../../storage/object-store';
import { NotificationConsumer } from '../../notifications/notifications.consumer';

let h: Harness;
let admin: VerificationController;
let kyc: PurohitKycController;

const asAdmin = () => ({ sub: 'admin_1', role: 'admin' }) as never;
const asPurohit = () => ({ sub: h.ids.panditId, role: 'pandit' }) as never;

/** A complete application, the way the purohit screen builds one. */
const apply = async () => {
  for (const kind of ['identity', 'address', 'pan', 'qualification'] as const) {
    const signed = await kyc.uploadUrl(asPurohit(), { kind, contentType: 'image/jpeg' });
    await kyc.attach(asPurohit(), { kind, docKey: signed.key });
  }
  await kyc.setQualification(asPurohit(), { level: 'graduate' });
  // The face a family sees. Required since the devotee does not choose their purohit.
  await h.db.execute(sql`UPDATE pandit_profiles
                            SET photo_key = ${`profile/${h.ids.panditId}/photo-x.jpg`}
                          WHERE user_id = ${h.ids.panditId}`);
  return kyc.submit(asPurohit());
};

/** Mark one document the way a reviewer does, reading them one at a time. */
const mark = async (kind: string, decision: 'verified' | 'rejected', notes?: string) =>
  admin.reviewDocument(asAdmin(), h.ids.panditId, await docId(kind),
    decision === 'rejected' ? { decision, notes: notes ?? 'not readable' } : { decision });

const docId = async (kind: string) => {
  const r = await h.db.execute(sql`
    SELECT id FROM kyc_records WHERE pandit_id = ${h.ids.panditId} AND type = ${kind}::kyc_type`);
  return (((r as { rows?: Array<{ id: string }> }).rows ?? r) as Array<{ id: string }>)[0]!.id;
};

beforeEach(async () => {
  h = await makeHarness();
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id, referral_code)
    VALUES ('admin_1', '+919876500001', 'admin', ${h.ids.cityId}, 'ADMIN1')`);
  await h.db.execute(sql`UPDATE pandit_profiles SET kyc_status='pending'
                          WHERE user_id = ${h.ids.panditId}`);
  kyc = new PurohitKycController(h.db, new InMemoryObjectStore());
  admin = new VerificationController(
    h.db, { record: async () => {} } as never, h.availability as never,
    { presignDownload: async () => 'https://x' } as never, h.outbox,
  );
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/**
 * Most review outcomes are not "no" — they are "send that one again".
 *
 * Review was approve-or-reject, so a reviewer who could not read one PAN card had to
 * reject the whole application, and the purohit, told only "rejected", re-uploaded
 * all four documents to fix one.
 */
describe('a reviewer can ask for one document again', () => {
  it('leaves the purohit under review rather than rejected', async () => {
    await apply();
    await mark('pan', 'rejected', 'the PAN photo is cut off at the edge');
    const res = await admin.requestChanges(asAdmin(), h.ids.panditId, {});
    expect(res.kycStatus).toBe('changes_requested');
  });

  it('flags only the document it names', async () => {
    await apply();
    // The reviewer passes the other three and flags one — the ordinary case.
    await mark('identity', 'verified');
    await mark('address', 'verified');
    await mark('qualification', 'verified');
    await mark('pan', 'rejected', 'the PAN photo is cut off at the edge');
    await admin.requestChanges(asAdmin(), h.ids.panditId, {});

    const status = await kyc.status(asPurohit());
    expect(status.flagged).toHaveLength(1);
    expect(status.flagged[0]!.kind).toBe('pan');
    expect(status.flagged[0]!.reason).toBe('the PAN photo is cut off at the edge');
  });

  /** The reason is the whole point — without it they send the same photo again. */
  it('refuses to reject a document with no reason', async () => {
    await apply();
    await expect(admin.reviewDocument(asAdmin(), h.ids.panditId, await docId('pan'),
      { decision: 'rejected', notes: '' })).rejects.toThrow();
  });

  /** Approving needs no reason — only a rejection has to explain itself. */
  it('approves a document without one', async () => {
    await apply();
    const res = await mark('identity', 'verified');
    expect(res).toMatchObject({ kind: 'identity', decision: 'verified' });
  });

  it('refuses to ask for changes when nothing is rejected', async () => {
    await apply();
    await mark('identity', 'verified');
    await expect(admin.requestChanges(asAdmin(), h.ids.panditId, {}))
      .rejects.toThrow(/at least one document/);
  });

  /** They must replace it, not simply press send again. */
  it('blocks re-submission until the flagged document is replaced', async () => {
    await apply();
    await mark('pan', 'rejected', 'cut off');
    await admin.requestChanges(asAdmin(), h.ids.panditId, {});

    expect((await kyc.status(asPurohit())).canSubmit).toBe(false);
    await expect(kyc.submit(asPurohit())).rejects.toThrow();
  });

  /**
   * The loop closes: replace the one document, and only that one, then submit again.
   * Re-uploading must SUPERSEDE the rejected record — leaving both in place would
   * keep the purohit blocked by a document they had already re-sent.
   */
  it('lets them replace just that document and submit again', async () => {
    await apply();
    await mark('pan', 'rejected', 'cut off');
    await admin.requestChanges(asAdmin(), h.ids.panditId, {});

    const signed = await kyc.uploadUrl(asPurohit(), { kind: 'pan', contentType: 'image/jpeg' });
    await kyc.attach(asPurohit(), { kind: 'pan', docKey: signed.key });

    const after = await kyc.status(asPurohit());
    expect(after.flagged, 'the superseded rejection still blocks them').toHaveLength(0);
    expect(after.canSubmit).toBe(true);
    expect(await kyc.submit(asPurohit())).toEqual({ status: 'submitted' });

    const r = await h.db.execute(sql`
      SELECT count(*)::int AS n FROM kyc_records
       WHERE pandit_id = ${h.ids.panditId} AND type = 'pan'`);
    const n = (((r as { rows?: Array<{ n: number }> }).rows ?? r) as Array<{ n: number }>)[0]!.n;
    expect(n, 'two PAN records exist and the reviewer cannot tell which is current').toBe(1);
  });

  /** A verified purohit is not sent back through review by a stray request. */
  it('refuses to ask a verified purohit for documents', async () => {
    await apply();
    await admin.decide(asAdmin(), h.ids.panditId, { decision: 'verified' });
    await expect(admin.requestChanges(asAdmin(), h.ids.panditId, {}))
      .rejects.toThrow(/already verified/);
  });

  it("refuses a document id belonging to another purohit", async () => {
    await apply();
    await h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id, referral_code)
      VALUES ('other_p', '+919830007777', 'pandit', ${h.ids.cityId}, 'OTHER')`);
    await h.db.execute(sql`
      INSERT INTO pandit_profiles (user_id, kyc_status) VALUES ('other_p', 'submitted')`);
    await h.db.execute(sql`
      INSERT INTO kyc_records (id, pandit_id, type, status, provider)
      VALUES ('d_other', 'other_p', 'identity', 'pending', 'manual')`);

    await expect(admin.reviewDocument(asAdmin(), h.ids.panditId, 'd_other',
      { decision: 'rejected', notes: 'tampered' })).rejects.toThrow(/does not belong/);
  });
});

/**
 * The purohit has to hear about it. A request sitting unseen on a screen they have no
 * reason to revisit is the same as no request at all — and they are the only person
 * who can act on it.
 */
describe('the purohit is told what happened', () => {
  const drain = async () => {
    const consumer = new NotificationConsumer(h.db, h.outbox, h.notifications);
    const r = await h.db.execute(sql`
      SELECT id, event_type, aggregate_id, payload::text AS payload FROM outbox
       WHERE event_type LIKE 'pandit.kyc.%'`);
    type Row = { id: string; event_type: string; aggregate_id: string; payload: string };
    const rows = (((r as { rows?: Row[] }).rows ?? r) as Row[]);
    for (const e of rows) {
      await consumer.publish({
        id: e.id, eventType: e.event_type, aggregateId: e.aggregate_id,
        payload: JSON.parse(e.payload),
      });
    }
  };

  const sentKeys = () => h.notifications.channel.sent
    .filter((m) => m.templateKey.startsWith('pandit.kyc.'))
    .map((m) => m.templateKey);

  it('messages them when a document is asked for again', async () => {
    await apply();
    await mark('pan', 'rejected', 'the PAN photo is cut off');
    await admin.requestChanges(asAdmin(), h.ids.panditId, {});
    await drain();
    expect(sentKeys()).toContain('pandit.kyc.changes_requested');
    expect(h.notifications.channel.sent.at(-1)!.body).toContain('cut off');
  });

  it('messages them when they are approved', async () => {
    await apply();
    await admin.decide(asAdmin(), h.ids.panditId, { decision: 'verified' });
    await drain();
    expect(sentKeys()).toContain('pandit.kyc.verified');
  });

  it('messages them when they are declined', async () => {
    await apply();
    await admin.decide(asAdmin(), h.ids.panditId, {
      decision: 'rejected', notes: 'the name does not match across documents',
    });
    await drain();
    expect(sentKeys()).toContain('pandit.kyc.rejected');
    expect(h.notifications.channel.sent.at(-1)!.body).toContain('does not match');
  });

  /** Never a blank message: "we need something" with no clue which document. */
  it('always says something actionable, even with no note', async () => {
    await apply();
    await admin.decide(asAdmin(), h.ids.panditId, { decision: 'rejected' });
    await drain();
    expect(h.notifications.channel.sent.at(-1)!.body).toContain('open the app');
  });
});

/**
 * A reviewer reads four documents one at a time.
 *
 * Review was a single verdict over the whole application, so there was nowhere to
 * record that the first three were fine — the reviewer held it in their head, and an
 * interruption meant starting again.
 */
describe('every document carries its own verdict', () => {
  it('records an approval against one document only', async () => {
    await apply();
    await mark('identity', 'verified');

    const docs = await admin.documents(h.ids.panditId);
    const byKind = Object.fromEntries(docs.map((d) => [d.type, d.status]));
    expect(byKind.identity).toBe('verified');
    expect(byKind.pan, 'approving one document marked the others').toBe('pending');
  });

  it('records a rejection with the reason the purohit will read', async () => {
    await apply();
    await mark('pan', 'rejected', 'the number is not legible');

    const docs = await admin.documents(h.ids.panditId);
    const pan = docs.find((d) => d.type === 'pan')!;
    expect(pan.status).toBe('rejected');
    expect(pan.notes).toBe('the number is not legible');
  });

  it('lets a reviewer change their mind', async () => {
    await apply();
    await mark('pan', 'rejected', 'looks cropped');
    await mark('pan', 'verified');

    const docs = await admin.documents(h.ids.panditId);
    expect(docs.find((d) => d.type === 'pan')!.status).toBe('verified');
  });

  /**
   * The point of recording them: a reviewer who is interrupted can see from the queue
   * how far they got, instead of starting the application again.
   */
  it('shows how far the review has got', async () => {
    await apply();
    await mark('identity', 'verified');
    await mark('address', 'verified');
    await mark('pan', 'rejected', 'cropped');

    const [row] = await admin.queue();
    expect(row!.reviewedDocs).toBe(3);
    expect(row!.rejectedDocs).toBe(1);
  });

  /** Approving the application clears the per-document state along with it. */
  it('settles every document when the application is approved', async () => {
    await apply();
    await mark('pan', 'rejected', 'cropped');
    await admin.decide(asAdmin(), h.ids.panditId, { decision: 'verified' });

    const docs = await admin.documents(h.ids.panditId);
    expect(docs.every((d) => d.status === 'verified'),
      'a rejected document survived approval and still blocks the purohit').toBe(true);
    expect((await kyc.status(asPurohit())).flagged).toHaveLength(0);
  });
});
