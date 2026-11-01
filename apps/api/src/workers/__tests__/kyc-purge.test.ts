import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { eq } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../test/harness';
import { kycRecords } from '../../db/schema/index';
import { InMemoryObjectStore } from '../../modules/storage/object-store';
import { KycPurgeJob } from '../kyc-purge.job';

let h: Harness;
let store: InMemoryObjectStore;
let job: KycPurgeJob;

async function document(over: Record<string, unknown> = {}) {
  const id = ulid();
  const docKey = `kyc/${h.ids.panditId}/identity-${id}.jpg`;
  store.put(docKey, 'image/jpeg', new Uint8Array([1, 2, 3]));
  await h.db.insert(kycRecords).values({
    id,
    panditId: h.ids.panditId,
    type: 'identity',
    status: 'verified',
    docKey,
    identifierLast4: '4321',
    ...over,
  } as never);
  return { id, docKey };
}

const daysFrom = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(async () => {
  h = await makeHarness();
  store = new InMemoryObjectStore();
  job = new KycPurgeJob(h.db, store);
});
afterEach(async () => { await h.pg.close(); });

/**
 * ADR 0010 promises a thirty-day purge, `doc_purge_after` is written on every
 * verification decision, the admin console renders "Null once purged" as a real
 * state, and `ObjectStore.delete` carries a docstring saying the purge job calls
 * it. There was no purge job — nothing in the repository called `delete`, so every
 * scan of a purohit's Aadhaar and PAN was retained indefinitely.
 */
describe('the KYC document purge', () => {
  it('deletes a document whose retention date has passed', async () => {
    const { docKey } = await document({ docPurgeAfter: daysFrom(-1) });

    expect(await job.run()).toBe(1);
    expect(store.get(docKey)).toBeUndefined();
  });

  it('clears the reference so the console can say it is gone', async () => {
    const { id } = await document({ docPurgeAfter: daysFrom(-1) });
    await job.run();

    const [row] = await h.db.select().from(kycRecords).where(eq(kycRecords.id, id));
    expect(row?.docKey).toBeNull();
    expect(row?.docPurgeAfter).toBeNull();
  });

  it('keeps the audit trail — the decision, the reviewer, the last four digits', async () => {
    // The row is what proves a human checked this person, and it is exactly what an
    // operator needs when an approval is questioned two years later. Only the image
    // is something we have no further business holding.
    const { id } = await document({ docPurgeAfter: daysFrom(-1), reviewNotes: 'clear scan' });
    await job.run();

    const [row] = await h.db.select().from(kycRecords).where(eq(kycRecords.id, id));
    expect(row).toBeDefined();
    expect(row?.status).toBe('verified');
    expect(row?.identifierLast4).toBe('4321');
    expect(row?.reviewNotes).toBe('clear scan');
  });

  it('leaves a document whose thirty days are not up', async () => {
    const { docKey } = await document({ docPurgeAfter: daysFrom(10) });

    expect(await job.run()).toBe(0);
    expect(store.get(docKey)).toBeDefined();
  });

  it('leaves a document still awaiting a decision', async () => {
    // No decision means no purge date. An undecided application must not have its
    // evidence deleted out from under the reviewer.
    const { docKey } = await document({ status: 'pending', docPurgeAfter: null });

    expect(await job.run()).toBe(0);
    expect(store.get(docKey)).toBeDefined();
  });

  it('keeps the reference when the delete fails, so the next run retries', async () => {
    /*
     * Nulling `doc_key` after a failed delete leaves the object in the bucket with
     * nothing pointing at it — an identity document we can neither serve nor ever
     * find again to remove. Retrying is the only outcome that converges on the
     * document actually being gone.
     */
    const { id } = await document({ docPurgeAfter: daysFrom(-1) });
    const broken = new KycPurgeJob(h.db, {
      ...store,
      delete: async () => { throw new Error('R2 unavailable'); },
    } as never);

    expect(await broken.run()).toBe(0);

    const [row] = await h.db.select().from(kycRecords).where(eq(kycRecords.id, id));
    expect(row?.docKey).not.toBeNull();

    // And the next healthy run finishes the job.
    expect(await job.run()).toBe(1);
  });
});
