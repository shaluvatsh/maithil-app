import { describe, it, expect, beforeEach } from 'vitest';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { CommunityService } from '../community.service';
import { AuditService } from '../../../common/audit';
import { ErrorCode } from '@themaithil/contracts';

/**
 * The moderation loop, end to end.
 *
 * C1 shipped the ability to HOLD a post and nothing that could release one, which
 * made an automated hold indistinguishable from a deletion — the single outcome
 * ADR 0016 says this product must never produce. These tests exist to keep the way
 * out of `held` from regressing, because the failure is silent: a held post looks
 * exactly like a post that was never written.
 */
interface Ctx { h: Harness; svc: CommunityService; devotee: string; admin: string }

async function setup(): Promise<Ctx> {
  const h = await makeHarness();
  const svc = new CommunityService(
    h.db,
    { feedPageSize: 20, askAfterHours: 24, grievanceAckHours: 24, grievanceResolveDays: 15 },
    { hasCompletedBooking: async () => false, avatarUrl: async (k) => `signed://${k}` },
    new AuditService(),
  );

  await h.db.execute(sql`
    INSERT INTO community_spaces (id, slug, kind, scope, city_id, posting_policy)
    VALUES (${ulid()}, 'annaprashan', 'ritual', 'city', ${h.ids.cityId}, 'open')`);

  const admin = ulid();
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id) VALUES (${admin}, '+919830000900', 'admin', ${h.ids.cityId})`);
  await h.db.execute(sql`UPDATE users SET created_at = now() - interval '72 hours'`);

  await svc.ensureProfile(h.ids.devoteeId, 'A Devotee');
  return { h, svc, devotee: h.ids.devoteeId, admin };
}

const ask = (c: Ctx, body?: string) => c.svc.ask({
  authorId: c.devotee,
  spaceSlug: 'annaprashan',
  title: 'Who feeds the child first at annaprashan?',
  body: body ?? 'My son turns six months next Falgun and the family disagrees about it.',
  locale: 'bn',
  scope: { scope: 'city', citySlug: 'kolkata' },
});

const rows = async <T>(c: Ctx, q: ReturnType<typeof sql>): Promise<T[]> => {
  const r = await c.h.db.execute(q);
  return ((r as unknown as { rows?: unknown[] }).rows ?? r) as T[];
};

const holdEverything = (c: Ctx) => c.h.db.execute(sql`
  INSERT INTO community_moderation_terms (id, locale, term, reason, source)
  VALUES (${ulid()}, NULL, 'annaprashan', 'other', 'test-list')`);

let c: Ctx;
beforeEach(async () => { c = await setup(); });

describe('a held post can be released', () => {
  it('puts it back in the feed, and dates it from the release', async () => {
    await holdEverything(c);
    const q = await ask(c);
    expect(q.state).toBe('held');
    expect((await c.svc.feed({ spaceSlug: 'annaprashan' })).items).toHaveLength(0);

    await c.svc.decide({
      postId: q.id, decision: 'release', actorId: c.admin, actorRole: 'admin',
    });

    const feed = await c.svc.feed({ spaceSlug: 'annaprashan' });
    expect(feed.items.map((i) => i.id)).toContain(q.id);

    // Dated from the release, not backdated to when it was written — the feed
    // sorts on this, and a post that claims to be three days old arrives buried.
    const [row] = await rows<{ published_at: string; held_at: string | null }>(c, sql`
      SELECT published_at, held_at FROM community_posts WHERE id = ${q.id}`);
    expect(row!.held_at).toBeNull();
    expect(Date.parse(row!.published_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('records who released it, in the same audit spine as KYC', async () => {
    await holdEverything(c);
    const q = await ask(c);
    await c.svc.decide({
      postId: q.id, decision: 'release', actorId: c.admin, actorRole: 'admin',
    });

    const audit = await rows<{ action: string; actor_id: string; entity_id: string }>(c, sql`
      SELECT action, actor_id, entity_id FROM audit_log WHERE entity_type = 'community_post'`);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'community.release', actor_id: c.admin, entity_id: q.id,
    });
  });
});

describe('a removal is a decision, so it carries a reason', () => {
  it('refuses to remove without one', async () => {
    const q = await ask(c);
    await expect(c.svc.decide({
      postId: q.id, decision: 'remove', actorId: c.admin, actorRole: 'admin',
    })).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await expect(c.svc.decide({
      postId: q.id, decision: 'remove', reason: '   ', actorId: c.admin, actorRole: 'admin',
    })).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('removes it from the feed and keeps the reason and the actor', async () => {
    const q = await ask(c);
    await c.svc.decide({
      postId: q.id, decision: 'remove', reason: 'solicits an off-platform booking',
      actorId: c.admin, actorRole: 'admin',
    });

    expect((await c.svc.feed({ spaceSlug: 'annaprashan' })).items).toHaveLength(0);
    const [row] = await rows<{ state: string; held_reason: string; removed_at: string }>(c, sql`
      SELECT state, held_reason, removed_at FROM community_posts WHERE id = ${q.id}`);
    expect(row!.state).toBe('removed');
    expect(row!.held_reason).toMatch(/off-platform/);
    expect(row!.removed_at).toBeTruthy();
  });

  it('refuses a post that does not exist rather than silently doing nothing', async () => {
    await expect(c.svc.decide({
      postId: ulid(), decision: 'release', actorId: c.admin, actorRole: 'admin',
    })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});

describe('the queue is SLA order', () => {
  it('lists held posts oldest first, with the configured windows', async () => {
    await holdEverything(c);
    const first = await ask(c);
    await c.h.db.execute(sql`
      UPDATE community_posts SET held_at = now() - interval '3 days' WHERE id = ${first.id}`);
    const second = await ask(c);

    const queue = await c.svc.queue();
    expect(queue.held.map((h) => h.id)).toEqual([first.id, second.id]);
    // The windows travel with the queue rather than being restated in the console,
    // because they are legal windows set outside this codebase.
    expect(queue.sla).toEqual({ ackHours: 24, resolveDays: 15 });
  });

  it('lists open reports oldest first and drops them once resolved', async () => {
    const q = await ask(c);
    await c.svc.report({ postId: q.id, reporterId: c.admin, reason: 'off_platform' });

    let queue = await c.svc.queue();
    expect(queue.reports).toHaveLength(1);

    const reportId = String(queue.reports[0]!.id);
    await c.svc.resolveReport({
      reportId, state: 'rejected', resolution: 'considered; the post stands',
      actorId: c.admin, actorRole: 'admin',
    });

    queue = await c.svc.queue();
    expect(queue.reports).toHaveLength(0);
  });
});

describe('the two grievance clocks are separate obligations', () => {
  it('acknowledging stops the 24-hour clock without deciding anything', async () => {
    const q = await ask(c);
    await c.svc.report({ postId: q.id, reporterId: c.admin, reason: 'spam' });
    const [before] = await rows<{ id: string; acknowledged_at: string | null }>(c, sql`
      SELECT id, acknowledged_at FROM community_reports`);
    expect(before!.acknowledged_at).toBeNull();

    await c.svc.acknowledgeReport(before!.id);

    const [after] = await rows<{ state: string; acknowledged_at: string; resolved_at: string | null }>(c, sql`
      SELECT state, acknowledged_at, resolved_at FROM community_reports`);
    expect(after!.state).toBe('acknowledged');
    expect(after!.acknowledged_at).toBeTruthy();
    // Acknowledged is not resolved. The second clock is still running.
    expect(after!.resolved_at).toBeNull();
  });

  it('stamps acknowledgement too when an operator reads and decides in one sitting', async () => {
    const q = await ask(c);
    await c.svc.report({ postId: q.id, reporterId: c.admin, reason: 'sectarian' });
    const [r] = await rows<{ id: string }>(c, sql`SELECT id FROM community_reports`);

    await c.svc.resolveReport({
      reportId: r!.id, state: 'actioned', actorId: c.admin, actorRole: 'admin',
    });

    const [row] = await rows<{ acknowledged_at: string; resolved_at: string }>(c, sql`
      SELECT acknowledged_at, resolved_at FROM community_reports`);
    // Leaving acknowledgement null here would under-report compliance on exactly
    // the reports that were handled fastest.
    expect(row!.acknowledged_at).toBeTruthy();
    expect(row!.resolved_at).toBeTruthy();
  });

  it('refuses to resolve a report that does not exist', async () => {
    await expect(c.svc.resolveReport({
      reportId: ulid(), state: 'actioned', actorId: c.admin, actorRole: 'admin',
    })).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});

describe('restricting an account is the one thing time does not undo', () => {
  it('stops them starting threads, and survives a completed booking', async () => {
    const svcWithBooking = new CommunityService(
      c.h.db,
      { feedPageSize: 20, askAfterHours: 24, grievanceAckHours: 24, grievanceResolveDays: 15 },
      // Even the strongest promotion signal there is.
      { hasCompletedBooking: async () => true, avatarUrl: async (k) => `signed://${k}` },
      new AuditService(),
    );

    await c.svc.setTrust({
      userId: c.devotee, level: 'restricted', actorId: c.admin, actorRole: 'admin',
    });

    await expect(svcWithBooking.ask({
      authorId: c.devotee, spaceSlug: 'annaprashan',
      title: 'Another question about the annaprashan date',
      body: 'Asking again after being restricted, which must not be possible.',
      locale: 'bn', scope: { scope: 'city', citySlug: 'kolkata' },
    })).rejects.toMatchObject({ code: ErrorCode.COMMUNITY_TRUST_REQUIRED });
  });

  it('can be lifted, and both directions are audited', async () => {
    await c.svc.setTrust({
      userId: c.devotee, level: 'restricted', actorId: c.admin, actorRole: 'admin',
    });
    await c.svc.setTrust({
      userId: c.devotee, level: 'newcomer', actorId: c.admin, actorRole: 'admin',
    });

    await expect(ask(c)).resolves.toBeTruthy();

    const audit = await rows<{ action: string }>(c, sql`
      SELECT action FROM audit_log WHERE entity_type = 'community_profile' ORDER BY created_at`);
    expect(audit).toHaveLength(2);
    expect(audit.every((a) => a.action === 'community.set_trust')).toBe(true);
  });
});
