import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { COMMISSION_BPS } from '@themaithil/contracts';

/**
 * What the assistant is allowed to know.
 *
 * WHY THERE IS NO VECTOR STORE HERE.
 *
 * The corpus is the catalogue: 28 rituals, their translations, and the panchang
 * vocabulary — a few hundred short rows, none longer than a paragraph. Embedding
 * search over that is strictly worse than handing the model the whole thing: it adds
 * an index to keep in sync, an embedding provider to pay and depend on, and a recall
 * failure mode ("nearest neighbour" quietly returning the wrong puja) in exchange for
 * solving a context-size problem this corpus does not have. `pgvector` is not even
 * installed on this database.
 *
 * So retrieval here is two things, which is what the question actually needs:
 *
 *   1. The catalogue, rendered compactly and pinned behind a cache breakpoint, so it
 *      is written once per five minutes rather than per message.
 *   2. Structured lookups of the ASKING USER's own data — their bookings, their
 *      purohit profile — which is a database query with an owner check, and must
 *      never be a similarity search.
 *
 * `retrieve()` is the seam. If the corpus later grows past what fits comfortably —
 * a blog, thousands of ritual variants across many regions — this is the one
 * function to change, and the tools and the loop above it do not move.
 */
export interface Knowledge {
  /** Stable across requests, so it can sit behind a cache breakpoint. */
  corpus(locale: string): Promise<string>;
}

export class CatalogueKnowledge implements Knowledge {
  constructor(private readonly db: Db) {}

  /**
   * Cached in memory for five minutes.
   *
   * The catalogue changes when ops edit it, which is rarely, and every message would
   * otherwise pay for the same three queries. Five minutes also matches the prompt
   * cache TTL, so the string stays byte-identical for as long as the cache it feeds.
   */
  private cache = new Map<string, { at: number; text: string }>();
  private static readonly TTL_MS = 5 * 60_000;

  async corpus(locale: string): Promise<string> {
    const hit = this.cache.get(locale);
    if (hit && Date.now() - hit.at < CatalogueKnowledge.TTL_MS) return hit.text;

    const text = await this.build(locale);
    this.cache.set(locale, { at: Date.now(), text });
    return text;
  }

  private async build(locale: string): Promise<string> {
    /*
     * One row per ritual, in the best language we have for it.
     *
     * An inner join on the requested locale silently DROPS any ritual that has not
     * been translated into it — the assistant would then confidently say we do not
     * offer a puja that is in the catalogue. `DISTINCT ON` with an explicit
     * preference order keeps every active ritual and picks the requested locale,
     * then English, then whatever exists.
     */
    const rituals = await this.db.execute(sql`
      WITH priced AS (
        SELECT ritual_id,
               min(band_min_paise)::int AS lo,
               max(band_max_paise)::int AS hi
          FROM ritual_city_prices GROUP BY ritual_id
      )
      SELECT DISTINCT ON (r.id)
             r.slug, r.duration_min, r.delivery_mode,
             t.name, t.short_description, p.lo, p.hi
        FROM rituals r
        JOIN ritual_translations t ON t.ritual_id = r.id
        LEFT JOIN priced p ON p.ritual_id = r.id
       WHERE r.active
       ORDER BY r.id,
                (t.locale::text = ${locale}) DESC,
                (t.locale::text = 'en') DESC,
                t.locale::text`);

    type R = {
      slug: string; duration_min: number; delivery_mode: string | null;
      name: string; short_description: string; lo: number | null; hi: number | null;
    };
    const rows = (((rituals as { rows?: R[] }).rows ?? rituals) as R[]);

    const rupees = (p: number | null) =>
      p === null ? '—' : `₹${Math.round(p / 100).toLocaleString('en-IN')}`;

    const catalogue = rows
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((r) => [
      `- ${r.name} (${r.slug})`,
      `  ${r.short_description}`,
      `  about ${r.duration_min} minutes`,
      `  typically ${rupees(r.lo)}–${rupees(r.hi)}`,
      r.delivery_mode === 'virtual' ? '  online only — the purohit joins by video' : null,
    ].filter(Boolean).join('\n')).join('\n');

    /*
     * From the enum, not from `panchang_terms` — that table is (value_key, locale,
     * label), a translation table with no `kind` column at all. The enum is the
     * actual list of what we compute, and it cannot drift from the code.
     */
    const terms = await this.db.execute(sql`
      SELECT unnest(enum_range(NULL::panchang_kind))::text AS kind`);
    type Kind = { kind: string };
    const kindRows = (((terms as { rows?: Kind[] }).rows ?? terms) as Kind[]);
    const kinds = kindRows.map((k) => k.kind).join(', ');

    /*
     * The policies were only ever written in UI copy, so the assistant would have
     * invented them. Commission comes from the shared constant rather than a number
     * typed here, because two copies of a percentage that appears on invoices is one
     * copy too many.
     */
    return [
      '## Services we offer',
      catalogue,
      '',
      '## Panchang',
      `We compute the panchang in-house for two schools — Gupta Press and Bisuddha`,
      `Siddhanta — and show both, including where they disagree, rather than picking`,
      `one. Terms we cover: ${kinds}.`,
      '',
      '## How booking works',
      '- The devotee picks a ritual, a date and a start time, and gives an address.',
      '- The platform assigns a verified purohit — the devotee does not choose one.',
      '  They are told who was assigned, with their photo and experience, before paying.',
      '- A small booking amount is paid up front to hold the slot; the rest is settled',
      '  on the day, in cash or online depending on what they chose.',
      '- Every purohit is identity-checked by a person before they can be booked.',
      '',
      '## Money',
      `- Commission on a fully digital booking is ${COMMISSION_BPS.fully_digital / 100}%.`,
      '- Cancelling more than 48 hours ahead is a full refund of the booking amount.',
      '- Inside 48 hours the booking amount is retained.',
      '- If the purohit cancels, the devotee is refunded in full whatever the notice.',
      '',
      '## Samagri (materials)',
      '- "Pandit brings everything" — itemised at catalogue rates, added to the bill.',
      '- "I will arrange materials" — a checklist is sent in advance, nothing charged.',
      '- Online consultations need no materials. Online pujas need a few things kept',
      '  ready at the devotee\'s own end, which we list; we charge nothing for them.',
    ].join('\n');
  }
}
