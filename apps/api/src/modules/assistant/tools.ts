import Anthropic from '@anthropic-ai/sdk';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';

/**
 * Who is asking. Every tool is scoped to this and nothing else.
 *
 * Resolved from the phone number the message arrived from — which is already a
 * verified identity, because that is the number they signed up with and the number
 * their OTP went to. It is never taken from anything the model produced.
 */
export interface Caller {
  userId: string;
  role: 'devotee' | 'pandit' | 'admin' | 'ops';
  phone: string;
  locale: string;
}

/**
 * The tools the assistant may use.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a tool never takes an identity from the
 * model. Booking ids and purohit ids are always checked against `caller.userId`
 * inside the handler, so a model that hallucinates or is talked into naming someone
 * else's booking gets a refusal from the database, not that person's address.
 *
 * That is why these are hand-written rather than a generic "query the database"
 * tool: the value here is not that Claude can reach the data, it is that it can
 * reach exactly one person's data.
 */
export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'list_my_bookings',
    description:
      'The bookings belonging to the person asking — upcoming first. Use this for '
      + '"when is my puja", "what did I book", "is my pandit confirmed", or any '
      + 'question about their own bookings. Returns nothing for someone with none.',
    input_schema: {
      type: 'object',
      properties: {
        include_past: {
          type: 'boolean',
          description: 'Include completed and cancelled bookings. Default false.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'find_rituals',
    description:
      'Search the catalogue of pujas we offer, by name or by what the devotee '
      + 'describes ("something for a new house", "thread ceremony"). Returns the '
      + 'ritual slug needed to start a booking, with its price band and duration.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the devotee is looking for.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'check_times',
    description:
      'Which start times are available for a ritual on a given date in a city. '
      + 'Call this before proposing a time — never guess availability.',
    input_schema: {
      type: 'object',
      properties: {
        ritual_slug: { type: 'string' },
        date: { type: 'string', description: 'ISO date, e.g. 2026-09-14.' },
        city_slug: { type: 'string' },
      },
      required: ['ritual_slug', 'date', 'city_slug'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'my_addresses',
    description:
      'The saved addresses of the person asking, to offer as a venue rather than '
      + 'making them type one out. Never returns anyone else\'s address.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'start_booking',
    description:
      'Create a DRAFT booking and return a link for the devotee to review and pay. '
      + 'This does NOT charge anyone and does NOT confirm anything — the devotee '
      + 'completes payment on the website, sees the assigned purohit and the full '
      + 'price first, and can walk away. Only call this once you have confirmed the '
      + 'ritual, the date, the start time and the address with them.',
    input_schema: {
      type: 'object',
      properties: {
        ritual_slug: { type: 'string' },
        date: { type: 'string', description: 'ISO date.' },
        starts_at: { type: 'string', description: 'ISO datetime with offset.' },
        address_id: { type: 'string', description: 'From my_addresses.' },
        city_slug: { type: 'string' },
      },
      required: ['ritual_slug', 'date', 'starts_at', 'address_id', 'city_slug'],
      additionalProperties: false,
    },
    strict: true,
  },
  /* ---------------- purohit-only ---------------- */
  {
    name: 'my_jobs',
    description:
      'PUROHIT ONLY. The jobs assigned to the purohit asking — upcoming first.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'set_working_hours',
    description:
      'PUROHIT ONLY. Set the hours the purohit is available on a given weekday. '
      + 'Use for "I am free from 6am on Sundays" or "do not book me before 9".',
    input_schema: {
      type: 'object',
      properties: {
        weekday: { type: 'integer', description: '0 = Sunday, 6 = Saturday.' },
        starts_at: { type: 'string', description: 'HH:MM, 24-hour.' },
        ends_at: { type: 'string', description: 'HH:MM, 24-hour. May be before starts_at for hours that cross midnight.' },
      },
      required: ['weekday', 'starts_at', 'ends_at'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'block_time',
    description:
      'PUROHIT ONLY. Mark the purohit unavailable for a whole day, so nothing can '
      + 'be booked into it. Use for "I am travelling on the 12th".',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date.' },
        reason: { type: 'string' },
      },
      required: ['date'],
      additionalProperties: false,
    },
    strict: true,
  },
];

/** What a tool hands back to the model. Always a string — never a raw row. */
type ToolResult = { content: string; isError?: boolean };

export class AssistantTools {
  constructor(
    private readonly db: Db,
    private readonly deps: {
      bookableTimes(a: { ritualSlug: string; citySlug: string; date: string }):
        Promise<Array<{ startsAt: string; available: boolean }>>;
      startDraft(a: {
        userId: string; ritualSlug: string; citySlug: string; date: string;
        startsAt: string; addressId: string;
      }): Promise<{ id: string }>;
      webBaseUrl: string;
    },
  ) {}

  /**
   * Runs one tool call.
   *
   * Returns an error STRING rather than throwing, so the model can apologise and
   * recover in the same turn. A thrown exception here would abandon the
   * conversation mid-sentence, which on WhatsApp reads as the business ignoring you.
   */
  async run(caller: Caller, name: string, input: unknown): Promise<ToolResult> {
    try {
      switch (name) {
        case 'list_my_bookings': return await this.listBookings(caller, input);
        case 'find_rituals':     return await this.findRituals(caller, input);
        case 'check_times':      return await this.checkTimes(input);
        case 'my_addresses':     return await this.addresses(caller);
        case 'start_booking':    return await this.startBooking(caller, input);
        case 'my_jobs':          return await this.jobs(caller);
        case 'set_working_hours': return await this.setHours(caller, input);
        case 'block_time':       return await this.blockTime(caller, input);
        default:
          return { content: `no such tool: ${name}`, isError: true };
      }
    } catch (e) {
      return { content: `that did not work: ${(e as Error).message}`, isError: true };
    }
  }

  /** Refuses a purohit-only tool for anyone else, before it touches the database. */
  private purohit(caller: Caller): ToolResult | null {
    return caller.role === 'pandit' ? null : {
      content: 'that is only available to purohits, and this account is not one',
      isError: true,
    };
  }

  private async listBookings(caller: Caller, raw: unknown): Promise<ToolResult> {
    const includePast = (raw as { include_past?: boolean })?.include_past === true;
    const rows = await this.db.execute(sql`
      SELECT b.id, b.date, b.slot_start_at, b.state::text AS state,
             t.name AS ritual, u.name AS pandit
        FROM bookings b
        JOIN ritual_translations t
          ON t.ritual_id = b.ritual_id AND t.locale = ${caller.locale}::locale
        LEFT JOIN users u ON u.id = b.pandit_id
       WHERE b.devotee_id = ${caller.userId}
         ${includePast ? sql`` : sql`AND b.slot_start_at >= now()
             AND b.state NOT IN ('cancelled_devotee','cancelled_pandit','expired')`}
       ORDER BY b.slot_start_at
       LIMIT 20`);

    type B = {
      id: string; date: string; slot_start_at: string; state: string;
      ritual: string; pandit: string | null;
    };
    const list = (((rows as { rows?: B[] }).rows ?? rows) as B[]);
    if (list.length === 0) return { content: 'no bookings' };

    return {
      content: list.map((b) =>
        `${b.ritual} on ${b.date}, ${b.state}${b.pandit ? `, purohit ${b.pandit}` : ''} `
        + `(ref ${b.id.slice(-6)})`).join('\n'),
    };
  }

  private async findRituals(_caller: Caller, raw: unknown): Promise<ToolResult> {
    const q = String((raw as { query?: unknown })?.query ?? '').trim();
    if (!q) return { content: 'no query given', isError: true };

    /*
     * Ranked in TypeScript, not by the database.
     *
     * The obvious reach here is `pg_trgm` and `similarity()`, and the first version
     * did exactly that — but the extension is not installed on the test engine, so a
     * query that names `similarity()` does not degrade, it throws. Trading a hard
     * dependency for fuzzy matching over TWENTY-EIGHT rows is a bad trade: fetching
     * the whole catalogue costs nothing at this size, ranks the same way on every
     * engine, and is the same reasoning that kept a vector store out of `knowledge.ts`.
     *
     * Every locale's name is searched, not just the caller's: someone reading the app
     * in Bengali still types "griha pravesh" as often as not.
     */
    const rows = await this.db.execute(sql`
      SELECT r.slug, t.name, t.locale::text AS locale, t.short_description, r.duration_min
        FROM rituals r
        JOIN ritual_translations t ON t.ritual_id = r.id
       WHERE r.active`);

    type R = {
      slug: string; name: string; locale: string;
      short_description: string; duration_min: number;
    };
    const all = (((rows as { rows?: R[] }).rows ?? rows) as R[]);

    const scored = all
      .map((r) => ({ r, score: matchScore(q, [r.name, r.slug, r.short_description]) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    // One entry per ritual: the same puja has a row per locale, and returning it
    // three times reads as three different services.
    const seen = new Set<string>();
    const best = scored.filter((x) => !seen.has(x.r.slug) && seen.add(x.r.slug)).slice(0, 6);

    if (best.length === 0) return { content: 'nothing in the catalogue matches that' };
    return {
      content: best.map(({ r }) =>
        `${r.name} [${r.slug}] — ${r.short_description} (${r.duration_min} min)`).join('\n'),
    };
  }

  private async checkTimes(raw: unknown): Promise<ToolResult> {
    const a = raw as { ritual_slug?: string; date?: string; city_slug?: string };
    if (!a?.ritual_slug || !a?.date || !a?.city_slug) {
      return { content: 'need the ritual, the date and the city', isError: true };
    }
    const times = await this.deps.bookableTimes({
      ritualSlug: a.ritual_slug, citySlug: a.city_slug, date: a.date,
    });
    const free = times.filter((t) => t.available).map((t) => t.startsAt);
    if (free.length === 0) {
      return { content: `nothing available on ${a.date} — offer another date` };
    }
    // Capped: a full day is 48 half-hour windows, and a wall of timestamps crowds
    // out the model's own reasoning for no benefit.
    return { content: `available start times on ${a.date}:\n${free.slice(0, 16).join('\n')}` };
  }

  private async addresses(caller: Caller): Promise<ToolResult> {
    const rows = await this.db.execute(sql`
      SELECT a.id, a.label, a.line1, a.pincode, c.slug AS city
        FROM addresses a JOIN cities c ON c.id = a.city_id
       WHERE a.user_id = ${caller.userId}
       ORDER BY a.created_at DESC LIMIT 5`);
    type A = { id: string; label: string | null; line1: string; pincode: string; city: string };
    const list = (((rows as { rows?: A[] }).rows ?? rows) as A[]);
    if (list.length === 0) {
      return { content: 'no saved address — they will need to add one on the website' };
    }
    return {
      content: list.map((a) =>
        `${a.id} — ${a.label ?? 'address'}: ${a.line1}, ${a.city} ${a.pincode}`).join('\n'),
    };
  }

  /**
   * Creates a draft and hands back a link. Deliberately stops short of payment.
   *
   * The devotee sees the assigned purohit, the itemised price and the cancellation
   * terms on a screen we control before any money moves. An agent that could also
   * capture payment would be completing a financial transaction and dispatching a
   * stranger to someone's home on the strength of a chat message.
   */
  private async startBooking(caller: Caller, raw: unknown): Promise<ToolResult> {
    if (caller.role !== 'devotee') {
      return { content: 'only a devotee account can start a booking', isError: true };
    }
    const a = raw as Record<string, string | undefined>;
    for (const k of ['ritual_slug', 'date', 'starts_at', 'address_id', 'city_slug']) {
      if (!a?.[k]) return { content: `need ${k} before starting a booking`, isError: true };
    }

    /*
     * The address must belong to the caller.
     *
     * `start_booking` takes an `address_id` the model produced, and the model saw a
     * list of ids a moment ago — but "saw a list" is not "may only use that list".
     * Checked here so a wrong id is a refusal rather than a stranger's front door.
     */
    const owned = await this.db.execute(sql`
      SELECT 1 FROM addresses WHERE id = ${a.address_id!} AND user_id = ${caller.userId}`);
    const hit = (((owned as { rows?: unknown[] }).rows ?? owned) as unknown[]);
    if (hit.length === 0) {
      return { content: 'that address does not belong to this account', isError: true };
    }

    const draft = await this.deps.startDraft({
      userId: caller.userId,
      ritualSlug: a.ritual_slug!, citySlug: a.city_slug!,
      date: a.date!, startsAt: a.starts_at!, addressId: a.address_id!,
    });

    return {
      content: 'draft created — give the devotee this link to review the assigned '
        + 'purohit, see the full price and pay:\n'
        + `${this.deps.webBaseUrl}/book?draft=${draft.id}`,
    };
  }

  private async jobs(caller: Caller): Promise<ToolResult> {
    const deny = this.purohit(caller); if (deny) return deny;
    const rows = await this.db.execute(sql`
      SELECT b.id, b.date, b.slot_start_at, b.state::text AS state, t.name AS ritual
        FROM bookings b
        JOIN ritual_translations t
          ON t.ritual_id = b.ritual_id AND t.locale = ${caller.locale}::locale
       WHERE b.pandit_id = ${caller.userId}
         AND b.slot_start_at >= now()
         AND b.state IN ('pending_accept','confirmed','in_progress')
       ORDER BY b.slot_start_at LIMIT 20`);
    type J = { id: string; date: string; state: string; ritual: string };
    const list = (((rows as { rows?: J[] }).rows ?? rows) as J[]);
    if (list.length === 0) return { content: 'no upcoming jobs' };
    return {
      content: list.map((j) =>
        `${j.ritual} on ${j.date}, ${j.state} (ref ${j.id.slice(-6)})`).join('\n'),
    };
  }

  private async setHours(caller: Caller, raw: unknown): Promise<ToolResult> {
    const deny = this.purohit(caller); if (deny) return deny;
    const a = raw as { weekday?: number; starts_at?: string; ends_at?: string };
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof a?.weekday !== 'number' || a.weekday < 0 || a.weekday > 6) {
      return { content: 'weekday must be 0 (Sunday) through 6 (Saturday)', isError: true };
    }
    if (!time.test(a.starts_at ?? '') || !time.test(a.ends_at ?? '')) {
      return { content: 'times must be HH:MM on a 24-hour clock', isError: true };
    }

    /*
     * REPLACES that weekday, rather than adding a window to it.
     *
     * The primary key is (pandit_id, weekday, starts_at), so a purohit may hold
     * several windows on one day — a morning and an evening, say. That makes
     * `ON CONFLICT (pandit_id, weekday)` invalid, and it makes the naive upsert
     * wrong even if it were legal: a purohit who says "I am free 6 to 6 on Sunday"
     * means that IS their Sunday, not that it is one more window on top of hours
     * they may have forgotten setting months ago.
     */
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM pandit_working_hours
         WHERE pandit_id = ${caller.userId} AND weekday = ${a.weekday!}`);
      await tx.execute(sql`
        INSERT INTO pandit_working_hours (pandit_id, weekday, starts_at, ends_at)
        VALUES (${caller.userId}, ${a.weekday!}, ${a.starts_at!}::time, ${a.ends_at!}::time)`);
    });

    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return { content: `set: ${day[a.weekday]} ${a.starts_at}–${a.ends_at}` };
  }

  private async blockTime(caller: Caller, raw: unknown): Promise<ToolResult> {
    const deny = this.purohit(caller); if (deny) return deny;
    const a = raw as { date?: string; reason?: string };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a?.date ?? '')) {
      return { content: 'date must be YYYY-MM-DD', isError: true };
    }

    /*
     * Closes the day rather than deleting anything.
     *
     * A booking already confirmed for that day is a commitment to a family, not a
     * calendar entry — so this stops NEW bookings and leaves existing ones alone.
     * The purohit is told what is still standing so they can release it properly.
     */
    /*
     * `closed`, not `blocked` — the enum is (open, closed, booked, buffer), and
     * `blocked` was a word I assumed rather than read. Only `open` rows are touched,
     * so a slot already `booked` stays booked and a `buffer` stays a buffer.
     */
    await this.db.execute(sql`
      UPDATE availability SET status = 'closed'
       WHERE pandit_id = ${caller.userId} AND date = ${a.date!}::date
         AND status = 'open'`);

    const rows = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM bookings
       WHERE pandit_id = ${caller.userId} AND date = ${a.date!}::date
         AND state IN ('pending_accept','confirmed','in_progress')`);
    type N = { n: number };
    const n = (((rows as { rows?: N[] }).rows ?? rows) as N[])[0]!.n;

    return {
      content: n > 0
        ? `${a.date} is closed to new bookings. ${n} booking(s) already confirmed that `
          + 'day are untouched — tell them to cancel those from the app if they must.'
        : `${a.date} is closed — nothing can be booked into it`,
    };
  }
}

/**
 * How well a query matches any of a ritual's fields.
 *
 * Substring first, because that is what most queries are. Then a trigram overlap,
 * which is what catches the misspellings people actually type — "satyanarain" for
 * "Satyanarayan" — without needing a database extension to do it.
 */
function matchScore(query: string, fields: string[]): number {
  const q = norm(query);
  if (q.length < 2) return 0;

  let best = 0;
  for (const field of fields) {
    const f = norm(field);
    if (!f) continue;
    if (f.includes(q)) { best = Math.max(best, 1 + q.length / f.length); continue; }
    // Word-level substring: "griha pravesh puja" should match "griha pravesh".
    if (q.split(' ').every((w) => w.length > 2 && f.includes(w))) {
      best = Math.max(best, 1);
      continue;
    }
    const overlap = trigramOverlap(q, f);
    if (overlap > 0.34) best = Math.max(best, overlap);
  }
  return best;
}

/** Lowercased, punctuation dropped, whitespace collapsed. */
const norm = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Dice coefficient over character trigrams — the same idea `pg_trgm` implements. */
function trigramOverlap(a: string, b: string): number {
  const grams = (s: string) => {
    const padded = `  ${s} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
    return out;
  };
  const ga = grams(a), gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}
