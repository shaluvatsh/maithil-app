import { describe, it, expect, beforeEach } from 'vitest';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { AuditService } from '../../../common/audit';
import { CommunityService } from '../community.service';
import { ErrorCode, REDACTION_TOKEN, decodeCursor } from '@themaithil/contracts';

/**
 * Community C1, against real Postgres.
 *
 * These run the hand-written guards in `0026_community.sql`, not a mock of them —
 * the shape rule, the endorsement rule and the scope pairing are SQL, and a test
 * that stubbed them would prove nothing about the thing that actually protects the
 * data. Same reasoning as the booking guard suite.
 */

interface Ctx {
  h: Harness;
  svc: CommunityService;
  spaceId: string;
  completed: Set<string>;
  verifiedPanditB: string;
  unverifiedPandit: string;
  otherDevotee: string;
}

async function setup(): Promise<Ctx> {
  const h = await makeHarness();
  const completed = new Set<string>();

  const svc = new CommunityService(
    h.db,
    {
      feedPageSize: 20, askAfterHours: 24,
      grievanceAckHours: 24, grievanceResolveDays: 15,
    },
    {
      hasCompletedBooking: async (id) => completed.has(id),
      avatarUrl: async (key) => `signed://${key}`,
    },
    new AuditService(),
  );

  const spaceId = ulid();
  await h.db.execute(sql`
    INSERT INTO community_spaces (id, slug, kind, scope, city_id, posting_policy)
    VALUES (${spaceId}, 'annaprashan', 'ritual', 'city', ${h.ids.cityId}, 'open')`);

  const verifiedPanditB = ulid();
  const unverifiedPandit = ulid();
  const otherDevotee = ulid();
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id, name) VALUES
      (${verifiedPanditB},  '+919830000101', 'pandit',  ${h.ids.cityId}, 'Pandit B'),
      (${unverifiedPandit}, '+919830000102', 'pandit',  ${h.ids.cityId}, 'Pandit C'),
      (${otherDevotee},     '+919830000103', 'devotee', ${h.ids.cityId}, 'Real Name Devotee')`);
  await h.db.execute(sql`
    INSERT INTO pandit_profiles (user_id, kyc_status, experience_years) VALUES
      (${verifiedPanditB},  'verified', 22),
      (${unverifiedPandit}, 'pending',  3)`);

  // Everyone is old enough to ask; the ladder itself is tested separately.
  await h.db.execute(sql`UPDATE users SET created_at = now() - interval '72 hours'`);

  await svc.ensureProfile(h.ids.devoteeId, 'A Devotee');
  await svc.ensureProfile(h.ids.panditId, 'Pandit A');
  await svc.ensureProfile(verifiedPanditB, 'Pandit B');
  await svc.ensureProfile(unverifiedPandit, 'Pandit C');
  await svc.ensureProfile(otherDevotee, 'Quiet Devotee');

  return { h, svc, spaceId, completed, verifiedPanditB, unverifiedPandit, otherDevotee };
}

const ask = (c: Ctx, over: Partial<Parameters<CommunityService['ask']>[0]> = {}) =>
  c.svc.ask({
    authorId: c.h.ids.devoteeId,
    spaceSlug: 'annaprashan',
    title: 'Who feeds the child first at annaprashan?',
    body: 'My son turns six months next Falgun and the family disagrees about who feeds him.',
    locale: 'bn',
    scope: { scope: 'city', citySlug: 'kolkata' },
    ...over,
  });

let c: Ctx;
beforeEach(async () => { c = await setup(); });

describe('Law 1 — scope is explicit and the database enforces the pairing', () => {
  it('refuses a city-scoped row with no city', async () => {
    await expect(c.h.db.execute(sql`
      INSERT INTO community_posts (id, space_id, author_id, kind, root_id, title, body, scope, locale, published_at)
      VALUES (${'X'}, ${c.spaceId}, ${c.h.ids.devoteeId}, 'question', ${'X'}, 't', 'b', 'city', 'bn', now())`))
      .rejects.toThrow(/scope_target/);
  });

  it('refuses a national row that still names a city', async () => {
    const id = ulid();
    await expect(c.h.db.execute(sql`
      INSERT INTO community_posts (id, space_id, author_id, kind, root_id, title, body, scope, city_id, locale, published_at)
      VALUES (${id}, ${c.spaceId}, ${c.h.ids.devoteeId}, 'question', ${id}, 't', 'b', 'national', ${c.h.ids.cityId}, 'bn', now())`))
      .rejects.toThrow(/scope_target/);
  });

  it('rejects a city nobody serves rather than inventing one', async () => {
    await expect(ask(c, { scope: { scope: 'city', citySlug: 'atlantis' } }))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('accepts a state that packages/region actually covers, and refuses one it does not', async () => {
    await expect(ask(c, { scope: { scope: 'state', stateName: 'Tamil Nadu' } })).resolves.toBeTruthy();
    await expect(ask(c, { scope: { scope: 'state', stateName: 'Atlantis' } }))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('a published post always has the instant its cursor is built from', async () => {
    const id = ulid();
    await expect(c.h.db.execute(sql`
      INSERT INTO community_posts (id, space_id, author_id, kind, root_id, title, body, scope, city_id, locale, state, published_at)
      VALUES (${id}, ${c.spaceId}, ${c.h.ids.devoteeId}, 'question', ${id}, 't', 'b', 'city', ${c.h.ids.cityId}, 'bn', 'published', NULL)`))
      .rejects.toThrow(/published_has_instant/);
  });
});

describe('the thread shape — two levels, and no further', () => {
  it('lets an answer hang off a question and a reply off an answer', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    expect(a.kind).toBe('answer');
    const r = await c.svc.respond({
      authorId: c.h.ids.devoteeId, parentId: a.id, locale: 'bn', body: 'Thank you.',
    });
    expect(r.kind).toBe('reply');
  });

  it('refuses to nest a reply under a reply', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    const r = await c.svc.respond({
      authorId: c.h.ids.devoteeId, parentId: a.id, locale: 'bn', body: 'Thank you.',
    });
    await expect(c.svc.respond({
      authorId: c.h.ids.panditId, parentId: r.id, locale: 'bn', body: 'And one more thing.',
    })).rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
  });

  /** The service refuses first; this proves the database would too. */
  it('refuses at the database even when the service is bypassed', async () => {
    const q = await ask(c);
    const a = ulid();
    await c.h.db.execute(sql`
      INSERT INTO community_posts (id, space_id, author_id, kind, parent_id, root_id, body, scope, city_id, locale, published_at)
      VALUES (${a}, ${c.spaceId}, ${c.h.ids.panditId}, 'answer', ${q.id}, ${q.id}, 'an answer', 'city', ${c.h.ids.cityId}, 'bn', now())`);

    await expect(c.h.db.execute(sql`
      INSERT INTO community_posts (id, space_id, author_id, kind, parent_id, root_id, body, scope, city_id, locale, published_at)
      VALUES (${ulid()}, ${c.spaceId}, ${c.h.ids.panditId}, 'answer', ${a}, ${q.id}, 'nested', 'city', ${c.h.ids.cityId}, 'bn', now())`))
      .rejects.toThrow(/an answer must answer a question/);
  });

  it('insists a question has a title and an answer does not', async () => {
    const id = ulid();
    await expect(c.h.db.execute(sql`
      INSERT INTO community_posts (id, space_id, author_id, kind, root_id, body, scope, city_id, locale, published_at)
      VALUES (${id}, ${c.spaceId}, ${c.h.ids.devoteeId}, 'question', ${id}, 'b', 'city', ${c.h.ids.cityId}, 'bn', now())`))
      .rejects.toThrow(/needs a title/);
  });
});

describe('endorsement is the quality signal, so SQL owns it', () => {
  it('lets a verified purohit endorse someone else’s answer', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    await expect(c.svc.endorse(a.id, c.verifiedPanditB)).resolves.toMatchObject({ endorsed: true });
  });

  it('refuses an unverified purohit', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    await expect(c.svc.endorse(a.id, c.unverifiedPandit))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('refuses a devotee, however long they have been here', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    await expect(c.svc.endorse(a.id, c.otherDevotee))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('refuses self-endorsement and refuses endorsing a question', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    await expect(c.svc.endorse(a.id, c.h.ids.panditId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    await expect(c.svc.endorse(q.id, c.verifiedPanditB)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('is idempotent — endorsing twice is still one endorsement', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    await c.svc.endorse(a.id, c.verifiedPanditB);
    await expect(c.svc.endorse(a.id, c.verifiedPanditB))
      .resolves.toMatchObject({ alreadyEndorsed: true });
    const t = await c.svc.thread(q.id);
    expect(t.answers[0]!.endorsementCount).toBe(1);
  });
});

describe('Law 3 — counters are columns, maintained by the database', () => {
  it('tracks replies, pranams and endorsements without a COUNT at read time', async () => {
    const q = await ask(c);
    const a = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    await c.svc.pranam(a.id, c.h.ids.devoteeId);
    await c.svc.pranam(a.id, c.otherDevotee);
    await c.svc.endorse(a.id, c.verifiedPanditB);

    const t = await c.svc.thread(q.id, c.h.ids.devoteeId);
    expect(t.question.replyCount).toBe(1);
    expect(t.answers[0]!.pranamCount).toBe(2);
    expect(t.answers[0]!.endorsementCount).toBe(1);
    expect(t.answers[0]!.viewerHasPranamed).toBe(true);
  });

  it('decrements when a pranam is withdrawn, and never goes negative', async () => {
    const q = await ask(c);
    await c.svc.pranam(q.id, c.otherDevotee);
    await c.svc.unpranam(q.id, c.otherDevotee);
    await c.svc.unpranam(q.id, c.otherDevotee);
    const t = await c.svc.thread(q.id);
    expect(t.question.pranamCount).toBe(0);
  });

  it('is idempotent — one person, one pranam', async () => {
    const q = await ask(c);
    await c.svc.pranam(q.id, c.otherDevotee);
    await c.svc.pranam(q.id, c.otherDevotee);
    const t = await c.svc.thread(q.id);
    expect(t.question.pranamCount).toBe(1);
  });
});

describe('the trust ladder', () => {
  it('will not let a brand-new account start a thread', async () => {
    const fresh = ulid();
    await c.h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id) VALUES (${fresh}, '+919830000199', 'devotee', ${c.h.ids.cityId})`);
    await c.svc.ensureProfile(fresh, 'Brand New');

    await expect(ask(c, { authorId: fresh })).rejects.toMatchObject({
      code: ErrorCode.COMMUNITY_TRUST_REQUIRED,
    });
  });

  it('lets that same account reply immediately, because shutting them out costs more', async () => {
    const q = await ask(c);
    const fresh = ulid();
    await c.h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id) VALUES (${fresh}, '+919830000198', 'devotee', ${c.h.ids.cityId})`);
    await c.svc.ensureProfile(fresh, 'Brand New');

    await expect(c.svc.respond({
      authorId: fresh, parentId: q.id, locale: 'bn',
      body: 'We were told the same thing in our family last year, for what it is worth.',
    })).resolves.toBeTruthy();
  });

  it('promotes on a completed booking and records why', async () => {
    const fresh = ulid();
    await c.h.db.execute(sql`
      INSERT INTO users (id, phone, role, city_id) VALUES (${fresh}, '+919830000197', 'devotee', ${c.h.ids.cityId})`);
    await c.svc.ensureProfile(fresh, 'Has Booked');
    c.completed.add(fresh);

    await expect(ask(c, { authorId: fresh })).resolves.toBeTruthy();
    const rows = await c.h.db.execute(sql`
      SELECT trust_level, trust_reason FROM community_profiles WHERE user_id = ${fresh}`);
    const row = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      trust_level: string; trust_reason: string;
    }>;
    expect(row[0]).toMatchObject({ trust_level: 'contributor', trust_reason: 'completed_booking' });
  });

  it('never auto-promotes out of restricted — a moderator’s decision stands', async () => {
    c.completed.add(c.h.ids.devoteeId);
    await c.h.db.execute(sql`
      UPDATE community_profiles SET trust_level = 'restricted', trust_reason = 'moderation'
       WHERE user_id = ${c.h.ids.devoteeId}`);
    await expect(ask(c)).rejects.toMatchObject({ code: ErrorCode.COMMUNITY_TRUST_REQUIRED });
  });
});

describe('posting policy is structural, not a review queue', () => {
  it('keeps a devotee out of a verified-only space', async () => {
    await c.h.db.execute(sql`
      INSERT INTO community_spaces (id, slug, kind, scope, city_id, posting_policy)
      VALUES (${ulid()}, 'shastra', 'tradition', 'national', NULL, 'verified_only')`);
    await expect(ask(c, { spaceSlug: 'shastra', scope: { scope: 'national' } }))
      .rejects.toMatchObject({ code: ErrorCode.COMMUNITY_SPACE_CLOSED });
  });

  it('lets a verified purohit in', async () => {
    await c.h.db.execute(sql`
      INSERT INTO community_spaces (id, slug, kind, scope, city_id, posting_policy)
      VALUES (${ulid()}, 'shastra', 'tradition', 'national', NULL, 'verified_only')`);
    await expect(ask(c, {
      authorId: c.verifiedPanditB, spaceSlug: 'shastra', scope: { scope: 'national' },
    })).resolves.toBeTruthy();
  });
});

describe('contact details leave the post but not the record', () => {
  it('scrubs the body and keeps the raw text for a reviewer', async () => {
    const q = await ask(c, {
      body: 'Please call me on 9830012345 and I will explain what our family does.',
    });
    expect(q.redacted).toBe(true);

    const t = await c.svc.thread(q.id);
    expect(t.question.body).not.toContain('9830012345');
    expect(t.question.body).toContain(REDACTION_TOKEN);

    const rows = await c.h.db.execute(sql`
      SELECT raw_body FROM community_post_revisions WHERE post_id = ${q.id}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{ raw_body: string }>;
    expect(list[0]!.raw_body).toContain('9830012345');
  });

  it('keeps the revision log append-only', async () => {
    const q = await ask(c);
    await expect(c.h.db.execute(sql`
      UPDATE community_post_revisions SET raw_body = 'rewritten' WHERE post_id = ${q.id}`))
      .rejects.toThrow(/append-only/);
    await expect(c.h.db.execute(sql`
      DELETE FROM community_post_revisions WHERE post_id = ${q.id}`))
      .rejects.toThrow(/append-only/);
  });
});

describe('moderation holds, it does not delete', () => {
  it('holds a post whose body matches the lexicon, and keeps it out of the feed', async () => {
    await c.h.db.execute(sql`
      INSERT INTO community_moderation_terms (id, locale, term, reason, source)
      VALUES (${ulid()}, NULL, 'blessed amulet cure', 'medical_claim', 'test-list')`);

    const q = await ask(c, {
      body: 'A blessed amulet cure was suggested to us for my father, is that right?',
    });
    expect(q.state).toBe('held');

    const feed = await c.svc.feed({ spaceSlug: 'annaprashan' });
    expect(feed.items.map((i) => i.id)).not.toContain(q.id);

    // Held, not gone. The row is still there for a human to look at.
    const rows = await c.h.db.execute(sql`
      SELECT state, held_reason FROM community_posts WHERE id = ${q.id}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      state: string; held_reason: string;
    }>;
    expect(list[0]).toMatchObject({ state: 'held', held_reason: 'medical_claim' });
  });

  it('scans the title too — the part a reader cannot avoid', async () => {
    await c.h.db.execute(sql`
      INSERT INTO community_moderation_terms (id, locale, term, reason, source)
      VALUES (${ulid()}, NULL, 'guaranteed cure', 'medical_claim', 'test-list')`);

    // Triage was body-only, so a term in the HEADLINE published while the same
    // words three lines down were held — on the text that appears in every feed
    // row and every search result.
    const q = await ask(c, {
      title: 'A guaranteed cure was promised to us, is that right?',
      body: 'The family is asking whether we should go ahead with the ceremony.',
    });
    expect(q.state).toBe('held');
  });

  it('accepts one report per person and refuses a second from the same person', async () => {
    const q = await ask(c);
    await expect(c.svc.report({
      postId: q.id, reporterId: c.otherDevotee, reason: 'off_platform',
    })).resolves.toMatchObject({ reported: true });
    await expect(c.svc.report({
      postId: q.id, reporterId: c.otherDevotee, reason: 'spam',
    })).resolves.toMatchObject({ reported: true });

    const rows = await c.h.db.execute(sql`
      SELECT count(*)::int AS n FROM community_reports WHERE post_id = ${q.id}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{ n: number }>;
    expect(list[0]!.n).toBe(1);
  });
});

describe('the feed', () => {
  it('pages by cursor with no overlap and no gap', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const q = await ask(c, { title: `Question number ${i} about annaprashan` });
      ids.push(q.id);
    }

    const first = await c.svc.feed({ spaceSlug: 'annaprashan', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await c.svc.feed({ spaceSlug: 'annaprashan', limit: 2, cursor: first.nextCursor! });
    const third = await c.svc.feed({ spaceSlug: 'annaprashan', limit: 2, cursor: second.nextCursor! });

    const seen = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(third.nextCursor).toBeNull();
  });

  it('treats a malformed cursor as page one rather than an error', async () => {
    await ask(c);
    expect(decodeCursor('not-a-cursor')).toBeNull();
    await expect(c.svc.feed({ spaceSlug: 'annaprashan', cursor: 'not-a-cursor' }))
      .resolves.toMatchObject({ items: expect.any(Array) });
  });

  it('returns only the scripts the page actually needs', async () => {
    await ask(c, { locale: 'bn', title: 'A Bengali question about annaprashan' });
    await ask(c, { locale: 'ta', title: 'A Tamil question about annaprashan' });
    const feed = await c.svc.feed({ spaceSlug: 'annaprashan' });
    expect(feed.scripts).toEqual(['bengali', 'tamil']);
  });

  it('filters by scope and by language', async () => {
    await ask(c, { locale: 'bn', title: 'A Kolkata question about annaprashan' });
    await ask(c, {
      locale: 'ta', title: 'A national question about annaprashan',
      scope: { scope: 'national' },
    });

    const city = await c.svc.feed({ scope: 'city', citySlug: 'kolkata' });
    expect(city.items.every((i) => i.citySlug === 'kolkata')).toBe(true);

    const tamil = await c.svc.feed({ locales: ['ta'] });
    expect(tamil.items.every((i) => i.locale === 'ta')).toBe(true);
    expect(tamil.items.length).toBe(1);
  });
});

describe('thread ordering is the product', () => {
  it('puts a verified purohit above a more-pranamed layperson', async () => {
    const q = await ask(c);
    const lay = await c.svc.respond({
      authorId: c.otherDevotee, parentId: q.id, locale: 'bn',
      body: 'My grandmother always said the father should do it, that is what we did.',
    });
    const verified = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    await c.svc.pranam(lay.id, c.h.ids.devoteeId);
    await c.svc.pranam(lay.id, c.verifiedPanditB);

    const t = await c.svc.thread(q.id);
    expect(t.answers[0]!.id).toBe(verified.id);
    expect(t.answers[0]!.pranamCount).toBe(0);
    expect(t.answers[1]!.pranamCount).toBe(2);
  });

  it('lifts the accepted answer to the top, and only the asker may accept', async () => {
    const q = await ask(c);
    const first = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q.id, locale: 'bn',
      body: 'The maternal uncle feeds the first morsel in most Bengali households.',
    });
    const second = await c.svc.respond({
      authorId: c.verifiedPanditB, parentId: q.id, locale: 'bn',
      body: 'In our tradition the eldest male of the household performs it instead.',
    });

    await expect(c.svc.acceptAnswer(q.id, second.id, c.otherDevotee))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await c.svc.acceptAnswer(q.id, second.id, c.h.ids.devoteeId);
    const t = await c.svc.thread(q.id);
    expect(t.answers[0]!.id).toBe(second.id);
    expect(t.answers[0]!.isAcceptedAnswer).toBe(true);
    expect(t.answers[1]!.id).toBe(first.id);
  });

  it('refuses to accept an answer belonging to a different question', async () => {
    const q1 = await ask(c);
    const q2 = await ask(c, { title: 'A second question about the annaprashan date' });
    const a2 = await c.svc.respond({
      authorId: c.h.ids.panditId, parentId: q2.id, locale: 'bn',
      body: 'Pick the tithi your own panjika gives, not the one the hall is free on.',
    });
    await expect(c.svc.acceptAnswer(q1.id, a2.id, c.h.ids.devoteeId))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});

describe('community identity is not marketplace identity', () => {
  it('never renders the real name on a community surface', async () => {
    const q = await ask(c, { authorId: c.otherDevotee });
    const t = await c.svc.thread(q.id);
    expect(t.question.author.displayName).toBe('Quiet Devotee');
    expect(JSON.stringify(t)).not.toContain('Real Name Devotee');
  });

  it('exposes no phone, city or booking history for a devotee author', async () => {
    const q = await ask(c, { authorId: c.otherDevotee });
    const t = await c.svc.thread(q.id);
    expect(JSON.stringify(t.question.author)).not.toContain('9830000103');
    expect(t.question.author.verifiedPurohit).toBe(false);
    expect(t.question.author.experienceYears).toBeNull();
  });

  it('shows a verified purohit’s standing, because that is the whole asymmetry', async () => {
    const q = await ask(c);
    await c.svc.respond({
      authorId: c.verifiedPanditB, parentId: q.id, locale: 'bn',
      body: 'In our tradition the eldest male of the household performs it instead.',
    });
    const t = await c.svc.thread(q.id);
    expect(t.answers[0]!.author).toMatchObject({
      displayName: 'Pandit B', verifiedPurohit: true, experienceYears: 22,
    });
  });

  it('drops the tick the moment KYC is revoked, because it is read and never copied', async () => {
    const q = await ask(c);
    await c.svc.respond({
      authorId: c.verifiedPanditB, parentId: q.id, locale: 'bn',
      body: 'In our tradition the eldest male of the household performs it instead.',
    });
    await c.h.db.execute(sql`
      UPDATE pandit_profiles SET kyc_status = 'rejected' WHERE user_id = ${c.verifiedPanditB}`);
    const t = await c.svc.thread(q.id);
    expect(t.answers[0]!.author.verifiedPurohit).toBe(false);
    expect(t.answers[0]!.author.experienceYears).toBeNull();
  });
});
