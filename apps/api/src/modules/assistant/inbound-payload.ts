import { Logger } from '@nestjs/common';

const log = new Logger('whatsapp-inbound');

/** What the webhook needs, whatever envelope it arrived in. */
export interface InboundMessage {
  providerMessageId: string;
  from: string;
  text: string;
}

/**
 * Reads a BSP's inbound webhook body.
 *
 * WHY THIS IS TOLERANT RATHER THAN A FIXED SCHEMA.
 *
 * The outbound channel is written for a Gupshup-shaped API, but no BSP account
 * exists yet, so no real inbound payload has ever been seen — and BSPs differ in
 * their envelopes and change them between API versions. A single hardcoded shape
 * would have exactly one failure mode: every real message silently rejected, with a
 * log line saying only "could not parse".
 *
 * So this tries the shapes BSPs actually use, and when none match it logs the KEY
 * STRUCTURE of what did arrive — field names and types, never the contents. The
 * first real message then tells you the shape instead of costing a debugging
 * session, and adding it is one entry in the list below.
 *
 * Redaction is not optional here: the body is someone's message and the envelope
 * carries their phone number, so the diagnostic prints the skeleton and nothing else.
 */
export function parseInbound(raw: unknown): InboundMessage | { ignored: string } {
  const body = raw as Record<string, unknown>;
  if (!body || typeof body !== 'object') return { ignored: 'not an object' };

  /*
   * Delivery receipts and read markers, which arrive on the same webhook and vastly
   * outnumber real messages. Recognised explicitly so they are ignored quietly
   * rather than logged as unparseable every time someone opens a chat.
   */
  const kind = str(body.type) ?? str(body.eventType);
  if (kind && kind !== 'message' && kind !== 'text') {
    return { ignored: `event: ${kind}` };
  }

  for (const shape of SHAPES) {
    const hit = shape(body);
    if (hit) return hit;
  }

  log.warn(
    'inbound payload not recognised — add its shape to inbound-payload.ts. '
    + `structure: ${skeleton(body)}`,
  );
  return { ignored: 'unrecognised shape' };
}

type Shape = (b: Record<string, unknown>) => InboundMessage | null;

/**
 * Known envelopes, most specific first. Each is a few lines; adding the one your BSP
 * actually sends is meant to be a small, obvious edit.
 */
const SHAPES: Shape[] = [
  // Gupshup v2: everything nested under `payload`, with the text one level deeper.
  (b) => {
    const p = obj(b.payload);
    if (!p) return null;
    const inner = obj(p.payload);
    const text = str(inner?.text) ?? str(p.text);
    const from = str(p.source) ?? str(obj(p.sender)?.phone);
    const id = str(p.id) ?? str(b.messageId);
    return text && from && id ? { providerMessageId: id, from, text } : null;
  },

  // Meta Cloud API: messages[] under entry[].changes[].value.
  (b) => {
    const entry = arr(b.entry)?.[0];
    const change = arr(obj(entry)?.changes)?.[0];
    const value = obj(obj(change)?.value);
    const msg = obj(arr(value?.messages)?.[0]);
    if (!msg) return null;
    const text = str(obj(msg.text)?.body);
    const from = str(msg.from);
    const id = str(msg.id);
    return text && from && id ? { providerMessageId: id, from, text } : null;
  },

  // Flat: what several smaller BSPs send, and what our own tests post.
  (b) => {
    const text = str(b.text) ?? str(b.message) ?? str(b.body);
    const from = str(b.from) ?? str(b.source) ?? str(b.mobile) ?? str(b.phone);
    const id = str(b.messageId) ?? str(b.id) ?? str(b.message_id);
    return text && from && id ? { providerMessageId: id, from, text } : null;
  },
];

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v : null;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/**
 * The shape of a payload, with every value replaced by its type.
 *
 * `{"payload":{"id":"string","source":"string"}}` — enough to write a new adapter
 * from, and it cannot leak a phone number or the text of someone's message.
 */
export function skeleton(v: unknown, depth = 0): string {
  if (depth > 4) return '...';
  if (Array.isArray(v)) return v.length ? `[${skeleton(v[0], depth + 1)}]` : '[]';
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).slice(0, 24);
    return `{${entries.map(([k, val]) => `"${k}":${skeleton(val, depth + 1)}`).join(',')}}`;
  }
  return `"${v === null ? 'null' : typeof v}"`;
}
