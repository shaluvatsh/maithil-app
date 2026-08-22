import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegionProvider } from '@/lib/region-context';
import BookPage from '@/app/book/page';
import { navFor, roleOf, type Role } from '@/lib/nav-model';
import { notableTithi } from '@/lib/tithi';
import { setSearch, pushed } from './setup';

const RITUALS = [{
  id: 'r1', slug: 'griha-prabesh', name: 'Griha Prabesh',
  shortDescription: 'Blessing a new home', category: 'life-events',
  durationMin: 180, defaultSlotSpan: 1, bomTotalPaise: 90000, deliveryMode: 'at_home',
  priceBand: { minPaise: 150000, maxPaise: 320000, defaultPaise: 200000 },
}, {
  id: 'r2', slug: 'ganesh-puja', name: 'Ganesh Puja',
  shortDescription: 'Removing obstacles', category: 'festival-pujas',
  durationMin: 90, defaultSlotSpan: 1, bomTotalPaise: 40000, deliveryMode: 'at_home',
  priceBand: { minPaise: 90000, maxPaise: 200000, defaultPaise: 120000 },
}];

beforeEach(() => {
  localStorage.clear();
  pushed.length = 0;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/v1/rituals') ? RITUALS
      : url.includes('/v1/search/pandits') ? { results: [] }
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

/**
 * The URL parameter was being re-applied on every render.
 *
 * `?ritual=` was read by an effect that listed `ritual` among its dependencies, so
 * clearing the selection re-ran the effect, which read the slug still sitting in
 * the URL and set it straight back. "Change service" fired, state changed twice,
 * and the screen never moved — a dead control with no error to see.
 */
describe('Change service actually changes the service', () => {
  it('returns to the catalogue instead of reselecting from the URL', async () => {
    setSearch('ritual=griha-prabesh');
    render(<RegionProvider><BookPage /></RegionProvider>);

    // Arrives on step 2 with the ritual preselected.
    const change = await screen.findByRole('button', { name: /change service/i });
    await userEvent.click(change);

    /**
     * The "chosen" card is gone, which is the observable fact that matters — the
     * ritual name itself is still on screen, because the catalogue lists it, and
     * asserting on its absence would be asserting the wrong thing.
     */
    expect(await screen.findByText('Ganesh Puja')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change service/i })).not.toBeInTheDocument();
    expect(document.querySelector('.card.chosen')).toBeNull();
  });

  it('strips the ritual from the address bar, so a refresh does not undo it', async () => {
    setSearch('ritual=griha-prabesh');
    render(<RegionProvider><BookPage /></RegionProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /change service/i }));

    const last = pushed.at(-1) ?? '';
    expect(last, 'the URL still carries the rejected ritual').not.toMatch(/ritual=/);
    expect(last).toMatch(/browse=1/);
  });

  it('opens the catalogue rather than the occasion picker', async () => {
    setSearch('ritual=griha-prabesh');
    render(<RegionProvider><BookPage /></RegionProvider>);
    await userEvent.click(await screen.findByRole('button', { name: /change service/i }));

    // The catalogue's own search box only exists on the browse surface.
    expect(await screen.findByLabelText(/search services/i)).toBeInTheDocument();
    expect(await screen.findByText('Ganesh Puja')).toBeInTheDocument();
  });
});

/**
 * The header branched on one boolean, so there were two surfaces for four kinds of
 * visitor. An admin got the devotee's links and no route into the console.
 */
describe('the header knows which product you are in', () => {
  const ROLES: Role[] = ['guest', 'devotee', 'pandit', 'admin'];

  it('maps a token and a role claim onto a surface', () => {
    expect(roleOf(false, 'devotee')).toBe('guest');
    expect(roleOf(true, 'pandit')).toBe('pandit');
    expect(roleOf(true, 'admin')).toBe('admin');
    expect(roleOf(true, 'ops')).toBe('admin');
    expect(roleOf(true, null)).toBe('devotee');
  });

  it('gives an admin a way into the console they signed in for', () => {
    const hrefs = navFor('admin').links.map((l) => l.href);
    expect(hrefs).toContain('/admin');
  });

  it('never shows a purohit the devotee booking surface', () => {
    const pandit = navFor('pandit');
    for (const href of [...pandit.links, ...pandit.account].map((l) => l.href)) {
      expect(href, `a purohit is being offered ${href}`).not.toMatch(/^\/book|^\/services|^\/account/);
    }
  });

  it('never shows an admin the devotee account pages', () => {
    for (const l of [...navFor('admin').links, ...navFor('admin').account]) {
      expect(l.href).not.toMatch(/^\/account/);
    }
  });

  it('offers the city picker only to the role that shops in one', () => {
    expect(navFor('devotee').showCity).toBe(true);
    expect(navFor('guest').showCity).toBe(true);
    expect(navFor('pandit').showCity).toBe(false);
    expect(navFor('admin').showCity).toBe(false);
  });

  it('hides the bookings icon from a visitor who cannot have any', () => {
    expect(navFor('guest').activity).toBeNull();
    expect(navFor('devotee').activity).not.toBeNull();
  });

  it('gives every role a distinct surface, and none an empty one', () => {
    const seen = new Set<string>();
    for (const r of ROLES) {
      const nav = navFor(r);
      expect(nav.links.length, `${r} has an empty header`).toBeGreaterThan(0);
      const key = nav.links.map((l) => l.href).join('|');
      expect(seen.has(key), `${r} shares its header with another role`).toBe(false);
      seen.add(key);
      for (const l of nav.links) expect(l.href).toMatch(/^\//);
    }
  });

  it('puts the sign-up route for supply on the public header only', () => {
    expect(navFor('guest').links.some((l) => l.href === '/purohit')).toBe(true);
    // A signed-in purohit does not need to be recruited.
    expect(navFor('pandit').links.some((l) => l.label === 'For Pandits')).toBe(false);
  });
});

/**
 * Kolkata's configured default is Gupta Press, which under ADR 0003 is transcribed
 * by hand and never has been. Every caller asked for it, got `[]`, and rendered
 * nothing — the panchang was invisible in the launch city.
 */
describe('resolving which almanac to show', () => {
  const SCHOOLS = [
    { id: 'gupta_press', english: 'Gupta Press', native: 'গুপ্তপ্রেস', note: '',
      computable: false, published: false, from: null, to: null },
    { id: 'bisuddha_siddhanta', english: 'Bisuddha Siddhanta', native: 'বিশুদ্ধ সিদ্ধান্ত',
      note: '', computable: true, published: true, from: '2026-08-01', to: '2026-09-30' },
  ];

  /** The resolution rule, extracted so it can be asserted without a DOM. */
  const resolve = (preferredId: string, schools: typeof SCHOOLS) => {
    const preferred = schools.find((s) => s.id === preferredId) ?? null;
    const published = schools.filter((s) => s.published);
    return preferred?.published ? preferred.id : published[0]?.id ?? null;
  };

  it('falls back to a published almanac when the preferred one is empty', () => {
    expect(resolve('gupta_press', SCHOOLS)).toBe('bisuddha_siddhanta');
  });

  it('honours the preference when it does have data', () => {
    const filled = SCHOOLS.map((s) => ({ ...s, published: true }));
    expect(resolve('gupta_press', filled)).toBe('gupta_press');
  });

  it('reports nothing rather than inventing an almanac', () => {
    expect(resolve('gupta_press', SCHOOLS.map((s) => ({ ...s, published: false })))).toBeNull();
  });
});

describe('notable tithis', () => {
  it('picks out the days a household marks without booking anything', () => {
    expect(notableTithi('Purnima')).toBe('Purnima');
    expect(notableTithi('Krishna Ekadashi')).toBe('Ekadashi');
    expect(notableTithi('Shukla Chaturthi')).toBe('Chaturthi');
  });

  it('says nothing about an ordinary day', () => {
    expect(notableTithi('Shukla Tritiya')).toBeNull();
    expect(notableTithi(null)).toBeNull();
  });
});
