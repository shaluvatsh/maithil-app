import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ulid } from 'ulid';
import { sql } from 'drizzle-orm';
import { makeHarness, type Harness } from '../../../test/harness';
import { KnowledgeService } from '../knowledge.service';
import { ErrorCode } from '@themaithil/contracts';

/**
 * The knowledge library. ADR 0014.
 *
 * The review gate is what these tests exist for. It is the library's only real
 * differentiator — every other app in this category publishes unsourced text — and it
 * is enforced in SQL precisely so no service refactor can quietly remove it. Several
 * tests therefore go straight at the table, the way a bad code path or a psql session
 * would.
 */
interface Ctx {
  h: Harness; svc: KnowledgeService;
  devotee: string; pandit: string; panditB: string; unverified: string; ops: string;
}

async function setup(): Promise<Ctx> {
  const h = await makeHarness();
  const svc = new KnowledgeService(
    h.db, { mediaUrl: async (k) => `signed://${k}` }, { pageSize: 20 },
  );

  const panditB = ulid(); const unverified = ulid(); const ops = ulid();
  await h.db.execute(sql`
    INSERT INTO users (id, phone, role, city_id, name) VALUES
      (${panditB},    '+919830000301', 'pandit',  ${h.ids.cityId}, 'Pandit B'),
      (${unverified}, '+919830000302', 'pandit',  ${h.ids.cityId}, 'Pandit C'),
      (${ops},        '+919830000303', 'ops',     ${h.ids.cityId}, 'Ops')`);
  await h.db.execute(sql`
    INSERT INTO pandit_profiles (user_id, kyc_status) VALUES
      (${panditB}, 'verified'), (${unverified}, 'pending')`);

  return { h, svc, devotee: h.ids.devoteeId, pandit: h.ids.panditId, panditB, unverified, ops };
}

const TEXT = {
  locale: 'bn' as const,
  title: 'অন্নপ্রাশনে কে প্রথম খাওয়াবেন',
  summary: 'বাংলা ঘরে মামার ভূমিকা, আর কোথায় বাবা করেন — সংক্ষেপে ব্যাখ্যা।',
  body: 'অন্নপ্রাশন শিশুর প্রথম অন্নগ্রহণ। বাংলার বহু পরিবারে মামা প্রথম গ্রাস তুলে দেন, '
    + 'আবার কোথাও গৃহকর্তা নিজেই করেন। দুটিই প্রচলিত এবং দুটিরই শাস্ত্রীয় ভিত্তি আছে।',
};

const draft = (c: Ctx, over: Record<string, unknown> = {}) => c.svc.create({
  authorId: c.pandit,
  slug: 'annaprashan-who-feeds-first',
  type: 'article',
  level: 'beginner',
  primaryLocale: 'bn',
  text: [TEXT],
  ...over,
} as never);

let c: Ctx;
beforeEach(async () => { c = await setup(); });
afterEach(async () => { await c?.h.pg.close(); });

describe('anyone may write; publishing is what is gated', () => {
  it('lets a devotee create a draft', async () => {
    const d = await draft(c, { authorId: c.devotee, slug: 'a-devotee-article' });
    expect(d.status).toBe('draft');
  });

  it('refuses a duplicate slug, because a slug is a URL for ever', async () => {
    await draft(c);
    await expect(draft(c)).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
  });

  it('insists the named original language is actually supplied', async () => {
    // Naming a language they did not write would make every translation look like an
    // original and none of them the source.
    await expect(draft(c, { primaryLocale: 'ta' }))
      .rejects.toMatchObject({ code: ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE });
  });

  it('refuses a ritual that does not exist rather than filing it under nothing', async () => {
    await expect(draft(c, { ritualSlug: 'not-a-ritual' }))
      .rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('records which text is the author’s own words', async () => {
    const d = await draft(c, {
      text: [TEXT, { ...TEXT, locale: 'en', title: 'Who feeds the child first',
        summary: 'The maternal uncle in most Bengali households, and where the father does it instead.',
        body: 'Annaprashan is the child’s first solid food. In many Bengali families the '
          + 'maternal uncle offers the first morsel; elsewhere the head of the household does.' }],
    });
    const rows = await c.h.db.execute(sql`
      SELECT locale, translated_by FROM knowledge_translations WHERE item_id = ${d.id}
       ORDER BY locale`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      locale: string; translated_by: string | null;
    }>;
    expect(list.find((x) => x.locale === 'bn')!.translated_by).toBeNull();
    expect(list.find((x) => x.locale === 'en')!.translated_by).toBe(c.pandit);
  });
});

describe('the review gate', () => {
  const submitted = async (over: Record<string, unknown> = {}) => {
    const d = await draft(c, over);
    await c.svc.submit(d.id, (over.authorId as string) ?? c.pandit);
    return d;
  };

  it('publishes on a verified purohit’s sign-off', async () => {
    const d = await submitted();
    const res = await c.svc.review({
      itemId: d.id, reviewerId: c.panditB, reviewerRole: 'pandit', decision: 'publish',
    });
    expect(res.status).toBe('published');
  });

  it('publishes on an operator’s sign-off', async () => {
    const d = await submitted();
    await expect(c.svc.review({
      itemId: d.id, reviewerId: c.ops, reviewerRole: 'ops', decision: 'publish',
    })).resolves.toMatchObject({ status: 'published' });
  });

  /** The rule that matters: nobody vouches for themselves. */
  it('refuses the author signing off their own work', async () => {
    const d = await submitted();
    await expect(c.svc.review({
      itemId: d.id, reviewerId: c.pandit, reviewerRole: 'pandit', decision: 'publish',
    })).rejects.toMatchObject({ code: ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE });
  });

  it('refuses an unverified purohit', async () => {
    const d = await submitted();
    await expect(c.svc.review({
      itemId: d.id, reviewerId: c.unverified, reviewerRole: 'pandit', decision: 'publish',
    })).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('refuses a devotee', async () => {
    const d = await submitted();
    await expect(c.svc.review({
      itemId: d.id, reviewerId: c.devotee, reviewerRole: 'devotee', decision: 'publish',
    })).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('sends it back with a note the author can act on', async () => {
    const d = await submitted();
    const res = await c.svc.review({
      itemId: d.id, reviewerId: c.panditB, reviewerRole: 'pandit',
      decision: 'changes', note: 'name the paddhati you are describing',
    });
    expect(res.status).toBe('draft');
    const rows = await c.h.db.execute(sql`
      SELECT review_note FROM knowledge_items WHERE id = ${d.id}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      review_note: string;
    }>;
    expect(list[0]!.review_note).toMatch(/paddhati/);
  });

  it('refuses to review something not in review', async () => {
    const d = await draft(c);
    await expect(c.svc.review({
      itemId: d.id, reviewerId: c.ops, reviewerRole: 'ops', decision: 'publish',
    })).rejects.toMatchObject({ code: ErrorCode.INVALID_TRANSITION });
  });
});

describe('the gate holds when the service is bypassed', () => {
  it('refuses a publish with no reviewer at all', async () => {
    const d = await draft(c);
    await expect(c.h.db.execute(sql`
      UPDATE knowledge_items SET status = 'published', published_at = now()
       WHERE id = ${d.id}`)).rejects.toThrow(/without a reviewer/);
  });

  it('refuses the author as their own reviewer', async () => {
    const d = await draft(c);
    await expect(c.h.db.execute(sql`
      UPDATE knowledge_items SET status = 'published', published_at = now(),
                                 reviewed_by = ${c.pandit}
       WHERE id = ${d.id}`)).rejects.toThrow(/cannot be the author/);
  });

  it('refuses an unverified purohit as reviewer', async () => {
    const d = await draft(c);
    await expect(c.h.db.execute(sql`
      UPDATE knowledge_items SET status = 'published', published_at = now(),
                                 reviewed_by = ${c.unverified}
       WHERE id = ${d.id}`)).rejects.toThrow(/verified purohit or an operator/);
  });

  it('refuses a published item with no text in any language', async () => {
    const id = ulid();
    // An item with no translation is a slug and a status. It would render as an
    // empty page with a working URL, which a crawler will happily index.
    await expect(c.h.db.execute(sql`
      INSERT INTO knowledge_items (id, slug, author_id, type, primary_locale, status,
                                   reviewed_by, published_at)
      VALUES (${id}, 'empty-item', ${c.pandit}, 'article', 'bn', 'published',
              ${c.ops}, now())`))
      .rejects.toThrow(/text in at least one language/);
  });

  it('will not let the last translation be deleted from under a published item', async () => {
    const d = await draft(c);
    await c.svc.submit(d.id, c.pandit);
    await c.svc.review({
      itemId: d.id, reviewerId: c.ops, reviewerRole: 'ops', decision: 'publish',
    });
    await expect(c.h.db.execute(sql`
      DELETE FROM knowledge_translations WHERE item_id = ${d.id}`))
      .rejects.toThrow(/keep text in at least one language/);
  });
});

describe('a recording without a transcript is half a product', () => {
  const audio = (over: Record<string, unknown> = {}) => draft(c, {
    slug: 'gayatri-mantra', type: 'mantra_audio', mediaKey: 'media/gayatri.mp3',
    durationSec: 42, ...over,
  });

  it('refuses to submit audio with no transcript', async () => {
    const d = await audio();
    await expect(c.svc.submit(d.id, c.pandit))
      .rejects.toMatchObject({ code: ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE });
  });

  it('refuses to submit audio with no recording', async () => {
    const d = await audio({ mediaKey: undefined, text: [{ ...TEXT, transcript: 'ওঁ ভূর্ভুবঃ স্বঃ' }] });
    await expect(c.svc.submit(d.id, c.pandit))
      .rejects.toMatchObject({ code: ErrorCode.KNOWLEDGE_NOT_PUBLISHABLE });
  });

  it('accepts audio that has both', async () => {
    const d = await audio({ text: [{ ...TEXT, transcript: 'ওঁ ভূর্ভুবঃ স্বঃ' }] });
    await expect(c.svc.submit(d.id, c.pandit)).resolves.toMatchObject({ status: 'in_review' });
  });

  it('refuses at the database too', async () => {
    const id = ulid();
    await c.h.db.execute(sql`
      INSERT INTO knowledge_items (id, slug, author_id, type, primary_locale, status)
      VALUES (${id}, 'no-media', ${c.pandit}, 'mantra_audio', 'bn', 'draft')`);
    await c.h.db.execute(sql`
      INSERT INTO knowledge_translations (item_id, locale, title, summary, body)
      VALUES (${id}, 'bn', 't', 's', 'b')`);
    await expect(c.h.db.execute(sql`
      UPDATE knowledge_items SET status = 'published', published_at = now(),
                                 reviewed_by = ${c.ops} WHERE id = ${id}`))
      .rejects.toThrow(/knowledge_media_present/);
  });
});

describe('reading the library', () => {
  const publish = async (over: Record<string, unknown> = {}) => {
    const d = await draft(c, over);
    await c.svc.submit(d.id, (over.authorId as string) ?? c.pandit);
    await c.svc.review({
      itemId: d.id, reviewerId: c.ops, reviewerRole: 'ops', decision: 'publish',
    });
    return d;
  };

  it('shows only published items', async () => {
    await publish();
    await draft(c, { slug: 'still-a-draft' });
    const res = await c.svc.browse({} as never);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.slug).toBe('annaprashan-who-feeds-first');
  });

  it('names who reviewed it, because that is the whole proposition', async () => {
    await publish();
    const res = await c.svc.browse({} as never);
    expect(res.items[0]!.reviewedByName).toBe('Ops');
  });

  /**
   * The fallback, and its honesty. A reader asking for Tamil gets the Bengali
   * original with the row saying so, rather than an empty library page.
   */
  it('falls back to the original and says which language it served', async () => {
    await publish();
    const res = await c.svc.browse({ locale: 'ta' } as never);
    expect(res.items[0]!.locale).toBe('bn');
    expect(res.items[0]!.original).toBe(true);
  });

  it('prefers the reader’s language when it exists, and marks it a translation', async () => {
    await publish({
      text: [TEXT, {
        locale: 'en', title: 'Who feeds the child first',
        summary: 'The maternal uncle in most Bengali households, and where the father does it.',
        body: 'Annaprashan is the first solid food. In many Bengali families the maternal '
          + 'uncle offers the first morsel; elsewhere the head of the household does it.',
      }],
    });
    const res = await c.svc.browse({ locale: 'en' } as never);
    expect(res.items[0]!.locale).toBe('en');
    expect(res.items[0]!.original).toBe(false);
  });

  it('reads one item by slug in a single lookup', async () => {
    await publish();
    const item = await c.svc.bySlug('annaprashan-who-feeds-first', 'bn');
    expect(item.title).toBe(TEXT.title);
    expect(item.body).toContain('অন্নপ্রাশন');
    expect(item.availableLocales).toEqual(['bn']);
  });

  it('refuses an unknown or unpublished slug', async () => {
    await draft(c, { slug: 'still-a-draft' });
    await expect(c.svc.bySlug('still-a-draft')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    await expect(c.svc.bySlug('nothing-here')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('carries citations, which are the trust moat', async () => {
    await publish({
      citations: [
        { work: 'Garuda Purana', chapter: '2', verse: '14', note: 'the order of rites' },
        { work: 'Manusmriti', chapter: '2' },
      ],
    });
    const item = await c.svc.bySlug('annaprashan-who-feeds-first');
    expect(item.citationCount).toBe(2);
    expect(item.citations.map((x) => x.work).sort()).toEqual(['Garuda Purana', 'Manusmriti']);
  });

  it('does not duplicate the same passage twice', async () => {
    await publish({
      citations: [
        { work: 'Garuda Purana', chapter: '2', verse: '14' },
        { work: 'Garuda Purana', chapter: '2', verse: '14' },
      ],
    });
    const item = await c.svc.bySlug('annaprashan-who-feeds-first');
    expect(item.citationCount).toBe(1);
  });

  it('pages by cursor without overlap', async () => {
    for (let i = 0; i < 3; i++) await publish({ slug: `guide-${i}` });
    const first = await c.svc.browse({ limit: 2 } as never);
    const second = await c.svc.browse({ limit: 2, cursor: first.nextCursor! } as never);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(3);
    expect(second.nextCursor).toBeNull();
  });

  it('filters by ritual, for a guide rendered on its own page', async () => {
    await publish({ slug: 'satya-guide', type: 'ritual_guide', ritualSlug: 'satyanarayan-puja' });
    await publish({ slug: 'unrelated' });
    const res = await c.svc.browse({ ritualSlug: 'satyanarayan-puja' } as never);
    expect(res.items.map((i) => i.slug)).toEqual(['satya-guide']);
  });
});

describe('retiring', () => {
  it('takes it out of the library but keeps who vouched for it', async () => {
    const d = await draft(c);
    await c.svc.submit(d.id, c.pandit);
    await c.svc.review({
      itemId: d.id, reviewerId: c.ops, reviewerRole: 'ops', decision: 'publish',
    });

    await c.svc.retire(d.id, c.ops, 'ops');
    expect((await c.svc.browse({} as never)).items).toHaveLength(0);

    const rows = await c.h.db.execute(sql`
      SELECT status, reviewed_by FROM knowledge_items WHERE id = ${d.id}`);
    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      status: string; reviewed_by: string;
    }>;
    // Retired, not erased: the record of who signed it off survives.
    expect(list[0]).toMatchObject({ status: 'retired', reviewed_by: c.ops });
  });

  it('refuses somebody else’s item', async () => {
    const d = await draft(c);
    await expect(c.svc.retire(d.id, c.devotee, 'devotee'))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

describe('the review queue', () => {
  it('lists what is waiting, oldest first', async () => {
    const a = await draft(c, { slug: 'first-in' });
    await c.svc.submit(a.id, c.pandit);
    await c.h.db.execute(sql`
      UPDATE knowledge_items SET updated_at = now() - interval '2 days' WHERE id = ${a.id}`);
    const b = await draft(c, { slug: 'second-in' });
    await c.svc.submit(b.id, c.pandit);

    const queue = await c.svc.reviewQueue();
    expect(queue.map((q) => q.slug)).toEqual(['first-in', 'second-in']);
  });

  it('holds nothing that is still a draft', async () => {
    await draft(c);
    expect(await c.svc.reviewQueue()).toEqual([]);
  });
});
