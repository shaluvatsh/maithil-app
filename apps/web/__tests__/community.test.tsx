import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import CommunityPage from '@/app/community/page';
import { ensureScriptFonts, scriptOf, communityMessage } from '@/lib/community';
import { navFor, roleOf } from '@/lib/nav-model';
import { createTranslator, getRegion, DEFAULT_LOCALE } from '@themaithil/region';
import { REDACTION_TOKEN } from '@themaithil/contracts';

/**
 * The community surface, tested for the things that only break pan-India.
 *
 * A feed is the one screen in this app that does not belong to a single region: it
 * mixes scripts, and the reader's own city describes neither the type on the page
 * nor the language of the answers. Everything below is a consequence of that.
 */

const BN_POST = {
  id: '01J0000000000000000000000A', kind: 'question',
  title: 'অন্নপ্রাশনে কে প্রথম খাওয়াবেন?',
  body: `মামা না বাবা? ${REDACTION_TOKEN} বলেছিলেন`,
  locale: 'bn', scope: 'national', citySlug: null, panjikaSchool: 'gupta_press',
  author: {
    id: '01J000000000000000000000AU', displayName: 'Pandit Asim', avatarUrl: null,
    verifiedPurohit: true, experienceYears: 22, panjikaSchool: 'gupta_press',
  },
  replyCount: 3, pranamCount: 84, endorsementCount: 7,
  viewerHasPranamed: false, isAcceptedAnswer: false,
  publishedAt: '2026-09-18T10:00:00.000Z',
};

const TA_POST = {
  ...BN_POST,
  id: '01J0000000000000000000000B',
  title: 'காதணி விழா எப்போது செய்ய வேண்டும்?',
  body: 'நல்ல நேரம் எது?',
  locale: 'ta', panjikaSchool: null,
  author: { ...BN_POST.author, id: '01J000000000000000000000BU', displayName: 'A Devotee', verifiedPurohit: false, experienceYears: null, panjikaSchool: null },
  replyCount: 1, pranamCount: 0, endorsementCount: 0,
};

const FEED = { items: [BN_POST, TA_POST], nextCursor: null, scripts: ['bengali', 'tamil'] };

beforeEach(() => {
  localStorage.clear();
  document.head.querySelectorAll('link[id^="font-"]').forEach((n) => n.remove());
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/v1/community/feed') ? FEED : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const renderFeed = () => render(<RegionProvider><CommunityPage /></RegionProvider>);

describe('the feed renders content written elsewhere', () => {
  it('shows questions in the script they were written in, not the region’s', async () => {
    renderFeed();
    const bn = await screen.findByText(BN_POST.title);
    const ta = await screen.findByText(TA_POST.title);

    // `lang` follows the WRITER, so the browser's line-breaking is right for each.
    expect(bn.closest('[lang]')).toHaveAttribute('lang', 'bn');
    expect(ta.closest('[lang]')).toHaveAttribute('lang', 'ta');
  });

  /*
   * Asserted through the translator rather than against literal text, so the test
   * proves the wiring rather than a dictionary entry.
   *
   * `DEFAULT_LOCALE` is passed because that is what the provider does: the app
   * opens in English in every city, including Kolkata (ADR 0017). An assertion
   * built from `createTranslator(region)` alone would resolve Bengali first and
   * describe a default the product no longer has.
   */
  const kolkata = getRegion('kolkata');
  const tk = createTranslator(kolkata, DEFAULT_LOCALE);

  it('never renders the redaction sentinel raw', async () => {
    renderFeed();
    await screen.findByText(BN_POST.title);
    expect(document.body.textContent).not.toContain(REDACTION_TOKEN);
    // Shown as something the reader understands, not silently erased — a gap with
    // no explanation reads as a bug, in any language.
    expect(screen.getAllByText(tk('community.redacted')).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain(tk('community.redacted'));
  });

  it('shows the panjika qualifier, because a calendar answer is school-specific', async () => {
    renderFeed();
    await screen.findByText(BN_POST.title);
    // The almanac's name comes from region config, in its own script.
    const school = kolkata.panjikas.find((p) => p.id === 'gupta_press')!;
    expect(screen.getByText(tk('community.accordingTo', { school: school.native })))
      .toBeInTheDocument();
    // And only on the post that declared one.
    expect(screen.getAllByText(/According to/)).toHaveLength(1);
  });

  it('shows the verified tick and years only for a verified purohit', async () => {
    renderFeed();
    await screen.findByText(BN_POST.title);
    expect(screen.getByText('Pandit Asim')).toBeInTheDocument();
    expect(screen.getByText('A Devotee')).toBeInTheDocument();

    // Exactly one tick: the devotee author must not carry one.
    expect(document.querySelectorAll('.cm-tick')).toHaveLength(1);
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  /**
   * The split that is easy to get backwards: TEXT is in the writer's script,
   * NUMBERS are in the reader's language.
   *
   * By default the reader's language is English, so a Bengali question shows
   * Latin digits even in Kolkata — the city has not changed, and digits belong to
   * the language rather than to the place. `language.test.tsx` covers what happens
   * when the reader switches.
   */
  it('renders counts in the reader’s language, not the city’s numerals', async () => {
    renderFeed();
    await screen.findByText(BN_POST.title);
    expect(document.body.textContent).toContain('84');
    expect(document.body.textContent).not.toContain('৮৪');
  });

  it('still typesets the question itself in Bengali', async () => {
    renderFeed();
    // The chrome being English does not make the CONTENT English. This is the
    // distinction the whole surface rests on.
    const bn = await screen.findByText(BN_POST.title);
    expect(bn.closest('[lang]')).toHaveAttribute('lang', 'bn');
  });
});

describe('fonts are fetched per item, not per region', () => {
  it('loads exactly the scripts the response contains', async () => {
    renderFeed();
    await screen.findByText(BN_POST.title);
    await waitFor(() => {
      expect(document.getElementById('font-bengali')).toBeTruthy();
      expect(document.getElementById('font-tamil')).toBeTruthy();
    });
    // And nothing else. Loading all nine subsets to be safe is hundreds of
    // kilobytes on exactly the devices this product depends on.
    expect(document.getElementById('font-telugu')).toBeNull();
    expect(document.getElementById('font-kannada')).toBeNull();
  });

  it('does not re-append a stylesheet when paging', () => {
    ensureScriptFonts(['bengali']);
    ensureScriptFonts(['bengali', 'bengali']);
    ensureScriptFonts(['bengali']);
    expect(document.head.querySelectorAll('#font-bengali')).toHaveLength(1);
  });

  it('maps every locale to a script and falls back rather than throwing', () => {
    expect(scriptOf('bn')).toBe('bengali');
    expect(scriptOf('ta')).toBe('tamil');
    expect(scriptOf('mr')).toBe('devanagari');
    expect(scriptOf('nonsense')).toBe('latin');
  });
});

describe('scope is chosen by the reader, not inferred', () => {
  it('defaults to everywhere and can be narrowed to the chosen city', async () => {
    const user = userEvent.setup();
    renderFeed();
    await screen.findByText(BN_POST.title);

    const calls = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]));

    // The first load asks for no scope at all — a ritual question has the same
    // answer in Pune and in Guwahati.
    expect(calls().some((u) => u.includes('/v1/community/feed') && !u.includes('scope='))).toBe(true);

    await user.click(screen.getByRole('button', { name: /^In / }));
    await waitFor(() => {
      expect(calls().some((u) => u.includes('scope=city') && u.includes('citySlug='))).toBe(true);
    });
  });
});

describe('refusals read as "not yet", not "not allowed"', () => {
  const t = createTranslator(getRegion('kolkata'), 'en');

  it('explains the trust ladder instead of showing a bare error', () => {
    const msg = communityMessage({ code: 'COMMUNITY_TRUST_REQUIRED', message: 'nope' }, t);
    expect(msg).toMatch(/not yet/i);
    expect(msg).toMatch(/reply to anything right now/i);
    expect(msg).not.toBe('nope');
  });

  it('passes anything else through rather than inventing copy', () => {
    expect(communityMessage(new Error('boom'), t)).toBe('boom');
  });
});

describe('the header', () => {
  it('offers community to signed-out visitors, because the feed is readable', () => {
    const links = navFor(roleOf(false, null)).links.map((l) => l.href);
    expect(links).toContain('/community');
  });

  it('offers it to purohits, whose reputation is the supply-retention argument', () => {
    const links = navFor(roleOf(true, 'pandit')).links.map((l) => l.href);
    expect(links).toContain('/community');
  });
});
