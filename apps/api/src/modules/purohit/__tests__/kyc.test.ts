import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { panditProfiles, kycRecords } from '../../../db/schema/index';
import { PurohitKycController } from '../kyc.controller';
import { InMemoryObjectStore } from '../../storage/object-store';
import { ErrorCode } from '@themaithil/contracts';

let h: Harness;
let store: InMemoryObjectStore;
let kyc: PurohitKycController;

const asPurohit = () => ({ sub: h.ids.panditId, role: 'pandit' }) as never;
const other = () => ({ sub: 'some-other-purohit', role: 'pandit' }) as never;

beforeEach(async () => {
  h = await makeHarness();
  store = new InMemoryObjectStore();
  kyc = new PurohitKycController(h.db, store);

  /*
   * Back to `pending`, because the harness seeds a VERIFIED purohit.
   *
   * It has to: every booking test needs someone a devotee can actually book, and
   * search filters on `kyc_status = 'verified'`. But that makes the harness the one
   * fixture in the repository where this feature's starting state is already the
   * end state, so the tests below have to say which purohit they mean — a
   * not-yet-verified one — rather than inherit it.
   */
  await h.db.update(panditProfiles).set({ kycStatus: 'pending' })
    .where(eq(panditProfiles.userId, h.ids.panditId));
}, 60_000);
afterEach(async () => { await h?.pg.close(); });

/** Upload a document end to end, the way the browser does it. */
type DocKind = 'identity' | 'address' | 'pan' | 'qualification' | 'credential' | 'demo' | 'bank';

const attach = async (kind: DocKind = 'identity', last4?: string) => {
  const signed = await kyc.uploadUrl(asPurohit(), { kind, contentType: 'image/jpeg' });
  return kyc.attach(asPurohit(), {
    kind, docKey: signed.key, ...(last4 ? { identifierLast4: last4 } : {}),
  });
};

/**
 * NOTHING EVER CREATED A KYC RECORD.
 *
 * `grep 'insert(kycRecords)'` returned nothing across the repository. The table was
 * designed in ADR 0010, the admin queue counted documents per purohit — a count that
 * could only ever be zero — and the queue filtered on `kyc_status IN
 * ('pending','submitted')` where `submitted` was unreachable because nothing could
 * set it. There was no upload anywhere in the product, so an admin approved purohits
 * on the strength of a name and a self-declared number of years.
 */
describe('a purohit can finally submit identity documents', () => {
  it('writes a kyc_records row — the first thing in the system that does', async () => {
    await attach('identity', '4321');

    const rows = await h.db.select().from(kycRecords)
      .where(eq(kycRecords.panditId, h.ids.panditId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('identity');
    expect(rows[0]!.docKey).toMatch(new RegExp(`^kyc/${h.ids.panditId}/identity-`));
  });

  /**
   * Everything a review needs, not just a photo ID — and the qualification the
   * certificate is meant to prove, which a reviewer cannot infer from the image.
   */
  const completeApplication = async () => {
    for (const k of ['identity', 'address', 'pan', 'qualification'] as const) await attach(k);
    await kyc.setQualification(asPurohit(), { level: 'graduate' });
    await setPhoto();
  };

  /** The face a family sees — required, because the devotee does not choose. */
  const setPhoto = () => h.db.update(panditProfiles)
    .set({ photoKey: `profile/${h.ids.panditId}/photo-x.jpg` })
    .where(eq(panditProfiles.userId, h.ids.panditId));

  it('moves the account into the previously unreachable submitted state', async () => {
    await completeApplication();
    expect(await kyc.submit(asPurohit())).toEqual({ status: 'submitted' });

    const [p] = await h.db.select({ status: panditProfiles.kycStatus })
      .from(panditProfiles).where(eq(panditProfiles.userId, h.ids.panditId));
    expect(p!.status).toBe('submitted');
  });

  /**
   * `pending` means "has not started"; `submitted` means "waiting on us". An operator
   * working a queue needs to tell those apart, and so does a purohit refreshing their
   * screen.
   */
  it('refuses to submit with no photo ID, naming what is missing', async () => {
    await expect(kyc.submit(asPurohit())).rejects.toThrow(/photo ID/i);

    const [p] = await h.db.select({ status: panditProfiles.kycStatus })
      .from(panditProfiles).where(eq(panditProfiles.userId, h.ids.panditId));
    expect(p!.status).toBe('pending');
  });

  it('does not count a credential as identity', async () => {
    await attach('credential');
    await expect(kyc.submit(asPurohit())).rejects.toThrow(/photo ID/i);
  });

  it('reports progress so the screen never has to infer it', async () => {
    const before = await kyc.status(asPurohit());
    expect(before.canSubmit).toBe(false);
    expect(before.missing).toEqual(['identity', 'address', 'pan', 'qualification']);
    expect(before.needsQualification).toBe(true);

    await attach('identity');
    const partway = await kyc.status(asPurohit());
    expect(partway.missing).toEqual(['address', 'pan', 'qualification']);
    expect(partway.documents).toHaveLength(1);
    expect(partway.canSubmit).toBe(false);

    await completeApplication();
    const done = await kyc.status(asPurohit());
    expect(done.missing).toEqual([]);
    expect(done.canSubmit).toBe(true);
    expect(done.highestQualification).toBe('graduate');
  });

  /**
   * The purohit must be told WHICH document is outstanding. "Your application is
   * incomplete" sends someone hunting through four upload tiles to find out.
   */
  it('names every document still missing', async () => {
    await attach('identity');
    await expect(kyc.submit(asPurohit())).rejects.toMatchObject({
      code: ErrorCode.KYC_INCOMPLETE,
      meta: { missing: ['address', 'pan', 'qualification'] },
    });
  });

  /**
   * A certificate with no claim attached tells a reviewer nothing — they would be
   * looking at a document without knowing what it is meant to prove.
   */
  it('refuses to submit a certificate with no qualification claimed', async () => {
    for (const k of ['identity', 'address', 'pan', 'qualification'] as const) await attach(k);
    // Everything else in place, so this isolates the qualification rule.
    await setPhoto();
    await expect(kyc.submit(asPurohit())).rejects.toMatchObject({
      code: ErrorCode.KYC_INCOMPLETE,
      meta: { missing: ['highestQualification'] },
    });
  });

  /**
   * The face a family sees before they let someone into their home.
   *
   * The booking screen rendered the first letter of the purohit's name in a circle,
   * and `photoUrl` had been on the search contract since the first commit with
   * `null` hardcoded into it. Since ADR 0012 the devotee does not choose their
   * purohit, so that letter was the only thing they saw before the door opened.
   */
  it('refuses to submit without a photo of the purohit', async () => {
    for (const k of ['identity', 'address', 'pan', 'qualification'] as const) await attach(k);
    await kyc.setQualification(asPurohit(), { level: 'graduate' });

    await expect(kyc.submit(asPurohit())).rejects.toMatchObject({
      code: ErrorCode.KYC_INCOMPLETE,
      meta: { missing: ['photo'] },
    });
    expect((await kyc.status(asPurohit())).needsPhoto).toBe(true);

    await setPhoto();
    const after = await kyc.status(asPurohit());
    expect(after.needsPhoto).toBe(false);
    expect(after.canSubmit).toBe(true);
  });
});

/**
 * ADR 0010: "No raw Aadhaar number is ever stored. Ever."
 *
 * Enforced by the schema rather than by a reviewer's discipline — a validator is how
 * that rule survives contact with a contributor who has not read the ADR.
 */
describe('no raw identity number can be stored', () => {
  it('rejects a full Aadhaar number', async () => {
    const signed = await kyc.uploadUrl(asPurohit(), {
      kind: 'identity', contentType: 'image/jpeg',
    });
    await expect(kyc.attach(asPurohit(), {
      kind: 'identity', docKey: signed.key, identifierLast4: '123456789012',
    })).rejects.toThrow();
  });

  it('rejects a PAN', async () => {
    const signed = await kyc.uploadUrl(asPurohit(), {
      kind: 'identity', contentType: 'image/jpeg',
    });
    await expect(kyc.attach(asPurohit(), {
      kind: 'identity', docKey: signed.key, identifierLast4: 'ABCDE1234F',
    })).rejects.toThrow();
  });

  it('accepts exactly four digits', async () => {
    await attach('identity', '4321');
    const [row] = await h.db.select().from(kycRecords)
      .where(eq(kycRecords.panditId, h.ids.panditId));
    expect(row!.identifierLast4).toBe('4321');
  });
});

describe('a document belongs to the purohit who uploaded it', () => {
  /**
   * Without this check a purohit could attach someone else's document key to their
   * own record and inherit a verification they did not earn — which is worse than no
   * verification, because it wears the badge.
   */
  it('refuses a key issued to another purohit', async () => {
    const signed = await kyc.uploadUrl(asPurohit(), {
      kind: 'identity', contentType: 'image/jpeg',
    });
    await expect(kyc.attach(other(), { kind: 'identity', docKey: signed.key }))
      .rejects.toThrow(/not yours/i);
  });

  it('refuses a hand-made key', async () => {
    await expect(kyc.attach(asPurohit(), {
      kind: 'identity', docKey: 'kyc/../../etc/passwd',
    })).rejects.toThrow(/not yours/i);
  });
});

describe('uploads', () => {
  it('refuses a content type a browser would execute', async () => {
    await expect(kyc.uploadUrl(asPurohit(), {
      kind: 'identity', contentType: 'text/html',
    })).rejects.toThrow();
    await expect(kyc.uploadUrl(asPurohit(), {
      kind: 'identity', contentType: 'image/svg+xml',
    })).rejects.toThrow();
  });

  it('never lets the client choose where the file lands', async () => {
    const signed = await kyc.uploadUrl(asPurohit(), {
      kind: 'identity', contentType: 'image/jpeg',
    });
    expect(signed.key.startsWith(`kyc/${h.ids.panditId}/`)).toBe(true);
    expect(store.uploads.has(signed.key)).toBe(true);
  });

  /**
   * Signing a URL is not evidence that anything was stored, which is why attaching
   * is a second call rather than a side effect of the first.
   */
  it('records nothing until the document is attached', async () => {
    await kyc.uploadUrl(asPurohit(), { kind: 'identity', contentType: 'image/jpeg' });
    expect(await h.db.select().from(kycRecords)
      .where(eq(kycRecords.panditId, h.ids.panditId))).toHaveLength(0);
  });

  it('stops a verified purohit re-uploading without support', async () => {
    await h.db.update(panditProfiles).set({ kycStatus: 'verified' })
      .where(eq(panditProfiles.userId, h.ids.panditId));
    await expect(kyc.uploadUrl(asPurohit(), {
      kind: 'identity', contentType: 'image/jpeg',
    })).rejects.toThrow(/already verified/i);
  });

  /**
   * A purohit verified before these rules existed — or one whose document images
   * have since been purged (ADR 0010) — must not be told to upload four documents
   * to re-enter a state they are already in.
   */
  it('leaves a verified purohit verified if submit is called again', async () => {
    await attach('identity');
    await h.db.update(panditProfiles).set({ kycStatus: 'verified' })
      .where(eq(panditProfiles.userId, h.ids.panditId));
    expect(await kyc.submit(asPurohit())).toEqual({ status: 'verified' });
  });
});
