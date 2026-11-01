import { describe, it, expect } from 'vitest';
import { parseInbound, skeleton } from '../inbound-payload';

/**
 * No BSP account exists yet, so no real inbound payload has ever been seen — and a
 * single hardcoded shape would have exactly one failure mode: every real message
 * silently rejected, with a log line saying only "could not parse".
 */
describe('inbound payloads from whichever BSP we end up on', () => {
  it('reads the Gupshup-style nested envelope', () => {
    const out = parseInbound({
      app: 'themaithil', type: 'message',
      payload: {
        id: 'wamid.1', source: '919830000001', type: 'text',
        payload: { text: 'hello' },
        sender: { phone: '919830000001', name: 'Debarati' },
      },
    });
    expect(out).toEqual({
      providerMessageId: 'wamid.1', from: '919830000001', text: 'hello',
    });
  });

  it('reads the Meta Cloud API envelope', () => {
    const out = parseInbound({
      entry: [{
        changes: [{
          value: {
            messages: [{ id: 'wamid.2', from: '919830000002', text: { body: 'namaskar' } }],
          },
        }],
      }],
    });
    expect(out).toEqual({
      providerMessageId: 'wamid.2', from: '919830000002', text: 'namaskar',
    });
  });

  it('reads a flat envelope', () => {
    expect(parseInbound({ messageId: 'm1', from: '+919830000003', text: 'hi' }))
      .toEqual({ providerMessageId: 'm1', from: '+919830000003', text: 'hi' });
  });

  /**
   * Delivery receipts and read markers arrive on the same webhook and vastly
   * outnumber real messages — they must be ignored quietly, not logged as
   * unparseable every time someone opens a chat.
   */
  it('ignores delivery and read events quietly', () => {
    for (const type of ['message-event', 'delivered', 'read', 'sandbox-start']) {
      const out = parseInbound({ type, payload: { id: 'x', type: 'read' } });
      expect(out).toHaveProperty('ignored');
    }
  });

  it('ignores a body with no message in it', () => {
    expect(parseInbound({ nothing: 'useful' })).toHaveProperty('ignored');
    expect(parseInbound(null)).toHaveProperty('ignored');
    expect(parseInbound('a string')).toHaveProperty('ignored');
  });

  it('ignores a message with no text, such as an image', () => {
    const out = parseInbound({
      type: 'message',
      payload: { id: 'i1', source: '919830000001', type: 'image', payload: { url: 'x' } },
    });
    expect(out).toHaveProperty('ignored');
  });
});

/**
 * The diagnostic exists so the FIRST real message tells us the shape. It must never
 * be the thing that leaks a phone number or the contents of someone's message into
 * a log.
 */
describe('the diagnostic prints structure, never content', () => {
  it('replaces every value with its type', () => {
    const out = skeleton({
      payload: { id: 'wamid.1', source: '919830000001', payload: { text: 'my secret' } },
    });
    expect(out).toContain('"source":"string"');
    expect(out).not.toContain('919830000001');
    expect(out).not.toContain('my secret');
  });

  it('shows an array by its first element', () => {
    expect(skeleton({ messages: [{ from: '91983', body: 'hi' }] }))
      .toBe('{"messages":[{"from":"string","body":"string"}]}');
  });

  it('stops before recursing forever', () => {
    let deep: Record<string, unknown> = { end: 'x' };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(skeleton(deep)).toContain('...');
  });

  it('handles empty arrays and nulls', () => {
    expect(skeleton({ a: [], b: null })).toBe('{"a":[],"b":"null"}');
  });
});
