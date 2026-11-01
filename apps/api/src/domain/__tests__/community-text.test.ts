import { describe, it, expect } from 'vitest';
import { REDACTION_TOKEN } from '@themaithil/contracts';
import { scrubContact, normaliseForMatching } from '../community-text';

/**
 * Contact scrubbing.
 *
 * The cases that matter are the FALSE POSITIVES. A scrubber that eats "108 diyas" or
 * "the 2026 almanac" makes religious questions unaskable, which costs more than the
 * leak it was protecting against. So the phone rule requires ten digits opening 6-9,
 * and every number below that passes through untouched.
 */
describe('scrubContact removes a way to reach someone off-platform', () => {
  it('strips a plain Indian mobile number', () => {
    const r = scrubContact('Please call me on 9830012345 to discuss');
    expect(r.text).not.toContain('9830012345');
    expect(r.text).toContain(REDACTION_TOKEN);
    expect(r.redacted).toBe(true);
  });

  it('strips the separators people actually type', () => {
    for (const raw of ['+91 98300 12345', '098300-12345', '91-9830012345', '9830 012 345']) {
      expect(scrubContact(`reach me ${raw}`).redacted, raw).toBe(true);
    }
  });

  it('strips email addresses and UPI handles', () => {
    expect(scrubContact('mail purohit@gmail.com').text).not.toContain('gmail');
    expect(scrubContact('pay me at 9830012345@ybl').text).not.toContain('ybl');
    expect(scrubContact('upi: asim@paytm').text).not.toContain('paytm');
  });

  it('strips links and messaging handles', () => {
    expect(scrubContact('see https://wa.me/919830012345').redacted).toBe(true);
    expect(scrubContact('find me at www.mypandit.in').redacted).toBe(true);
    expect(scrubContact('telegram @asim_purohit').redacted).toBe(true);
  });

  it('leaves the sentence readable so a moderator can see the intent', () => {
    const r = scrubContact('Call me on 9830012345 and I will do it for less');
    expect(r.text).toContain('Call me on');
    expect(r.text).toContain('I will do it for less');
  });

  it('collapses a run of redactions into one', () => {
    const r = scrubContact('9830012345 9830012346 9830012347');
    expect(r.text.match(new RegExp(REDACTION_TOKEN.replace(/[[\]]/g, '\\$&'), 'g'))?.length)
      .toBe(1);
  });
});

describe('scrubContact leaves religious text alone', () => {
  it('does not touch small numbers, which are everywhere in this domain', () => {
    for (const raw of [
      'should it be 108 or 1008 names?',
      'the 2026 Gupta Press panjika',
      'we are 25 people, is that too many?',
      'tithi ends at 14:32',
      'my son turns 5 in Falgun',
    ]) {
      const r = scrubContact(raw);
      expect(r.redacted, raw).toBe(false);
      expect(r.text, raw).toBe(raw);
    }
  });

  it('does not touch Bengali or Tamil prose', () => {
    const bn = 'আমার ছেলের অন্নপ্রাশন — মামা কি খাওয়াবেন, না বাবা?';
    const ta = 'என் மகனின் காதணி விழா எப்போது செய்ய வேண்டும்?';
    expect(scrubContact(bn).text).toBe(bn);
    expect(scrubContact(ta).text).toBe(ta);
  });

  it('is stable when called repeatedly, so global regex state cannot leak', () => {
    const raw = 'call 9830012345';
    const first = scrubContact(raw);
    const second = scrubContact(raw);
    expect(second).toEqual(first);
  });
});

describe('normaliseForMatching prepares text for the lexicon', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normaliseForMatching('  Hello,   WORLD!!  ')).toBe('hello world');
  });

  it('leaves Indic text intact, because there is no stemmer for it', () => {
    expect(normaliseForMatching('অন্নপ্রাশন  নিয়ম')).toBe('অন্নপ্রাশন নিয়ম');
  });
});
