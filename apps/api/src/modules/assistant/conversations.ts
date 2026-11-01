import { sql } from 'drizzle-orm';
import type Anthropic from '@anthropic-ai/sdk';
import type { Db } from '../../db/client';
import { normalisePhone } from '@themaithil/contracts';
import type { Caller } from './tools';

/**
 * How much history to carry. A booking conversation is a handful of turns; anything
 * longer is usually someone starting again, and sending a month of chat back on
 * every message costs more than the answer is worth.
 */
const MAX_HISTORY_MESSAGES = 24;

/** After this long with no message, the next one starts a fresh conversation. */
const IDLE_RESET_MS = 6 * 60 * 60_000;

export class Conversations {
  constructor(private readonly db: Db) {}

  /**
   * Who this number belongs to.
   *
   * The phone number IS the authentication here, and legitimately so: it is the
   * number they registered with and the number their login code goes to, and the BSP
   * has already proven the message came from it. What matters is that the identity
   * comes from the ENVELOPE, never from anything inside the message — a sender who
   * types "I am the admin" is a devotee typing a sentence.
   *
   * Returns null for a number we do not know. That is not an error: it is a stranger,
   * and they get the public answer.
   */
  async identify(rawPhone: string): Promise<Caller | null> {
    const phone = normalisePhone(rawPhone);
    const rows = await this.db.execute(sql`
      SELECT id, role::text AS role, locale::text AS locale
        FROM users WHERE phone = ${phone} LIMIT 1`);
    type U = { id: string; role: string; locale: string };
    const list = (((rows as { rows?: U[] }).rows ?? rows) as U[]);
    const u = list[0];
    if (!u) return null;
    return {
      userId: u.id,
      role: u.role as Caller['role'],
      phone,
      locale: u.locale || 'bn',
    };
  }

  /**
   * Records the inbound message, and says whether it is new.
   *
   * BSPs retry. An agent that creates bookings must not run twice on one message, so
   * this is a plain insert on a primary key — the second delivery collides and is
   * told so, rather than being deduplicated by a check-then-act that two concurrent
   * retries would both pass.
   */
  async claimInbound(args: {
    providerMessageId: string; phone: string; body: string;
  }): Promise<boolean> {
    const res = await this.db.execute(sql`
      INSERT INTO assistant_inbound (provider_message_id, phone, body)
      VALUES (${args.providerMessageId}, ${normalisePhone(args.phone)}, ${args.body})
      ON CONFLICT (provider_message_id) DO NOTHING
      RETURNING provider_message_id`);
    const rows = (((res as { rows?: unknown[] }).rows ?? res) as unknown[]);
    return rows.length > 0;
  }

  async history(phone: string): Promise<Anthropic.MessageParam[]> {
    const rows = await this.db.execute(sql`
      SELECT history, last_at FROM assistant_conversations
       WHERE phone = ${normalisePhone(phone)}`);
    type C = { history: unknown; last_at: string };
    const list = (((rows as { rows?: C[] }).rows ?? rows) as C[]);
    const row = list[0];
    if (!row) return [];

    // A conversation resumed after hours is a new subject, not turn nine of the old
    // one — and stale context makes the assistant answer the wrong question.
    if (Date.now() - new Date(row.last_at).getTime() > IDLE_RESET_MS) return [];

    const parsed = typeof row.history === 'string'
      ? JSON.parse(row.history) : row.history;
    return Array.isArray(parsed) ? (parsed as Anthropic.MessageParam[]) : [];
  }

  async save(phone: string, userId: string | null, history: Anthropic.MessageParam[]) {
    /*
     * Trimmed from the FRONT, and never leaving a tool_result orphaned.
     *
     * A `tool_result` whose matching `tool_use` was trimmed away is rejected by the
     * API — so a naive `slice(-24)` produces a conversation that throws on the next
     * message, and only for the users who talked the longest.
     */
    const trimmed = trimToUserBoundary(history, MAX_HISTORY_MESSAGES);

    await this.db.execute(sql`
      INSERT INTO assistant_conversations (phone, user_id, history, turns, last_at)
      VALUES (${normalisePhone(phone)}, ${userId},
              ${JSON.stringify(trimmed)}::jsonb, 1, now())
      ON CONFLICT (phone) DO UPDATE
        SET history = excluded.history,
            user_id = coalesce(excluded.user_id, assistant_conversations.user_id),
            turns   = assistant_conversations.turns + 1,
            last_at = now()`);
  }
}

/**
 * Keeps the last `max` messages, then walks forward to the first `user` message that
 * is not a tool result — so the history always begins somewhere the API accepts.
 */
export function trimToUserBoundary(
  history: Anthropic.MessageParam[], max: number,
): Anthropic.MessageParam[] {
  if (history.length <= max) return history;
  const tail = history.slice(-max);

  const startsCleanly = (m: Anthropic.MessageParam) =>
    m.role === 'user'
    && !(Array.isArray(m.content)
      && m.content.some((b) => (b as { type?: string }).type === 'tool_result'));

  const from = tail.findIndex(startsCleanly);
  return from === -1 ? [] : tail.slice(from);
}
