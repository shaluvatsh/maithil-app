import { setSearch } from './setup';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RegionProvider } from '@/lib/region-context';
import Home from '@/app/page';
import LoginPage from '@/app/login/page';
import BookPage from '@/app/book/page';
import PanchangPage from '@/app/panchang/page';
import { Nav } from '@/app/nav';

const withRegion = (node: React.ReactNode) =>
  render(<RegionProvider>{node}</RegionProvider>);

/**
 * This file previously ran with no fetch mock at all, which was fine only because
 * the home page's service cards were hardcoded. Now every card comes from the
 * catalogue, so the page needs data to have anything to assert against.
 */
const RITUALS = [{
  id: 'r1', slug: 'satyanarayan-puja', name: 'Satyanarayan Puja',
  shortDescription: 'Full katha and puja with sinni', category: 'festival-pujas',
  durationMin: 120, defaultSlotSpan: 1, bomTotalPaise: 80000, deliveryMode: 'at_home',
  priceBand: { minPaise: 110000, maxPaise: 250000, defaultPaise: 150000 },
}];

beforeEach(() => {
  // /book opens on the occasion picker now; these suites test the catalogue.
  setSearch('browse=1');
  localStorage.clear();
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

const PAGES: Array<[string, React.ReactNode]> = [
  ['home', <Home key="h" />],
  ['login', <LoginPage key="l" />],
  ['book', <BookPage key="b" />],
  ['panchang', <PanchangPage key="p" />],
  ['nav', <Nav key="n" />],
];

/**
 * Structural invariants.
 *
 * Every rule here exists because the codebase shipped a violation of it. These are
 * the cheapest possible guard against a whole class of bug that a typecheck and a
 * successful build both wave through.
 */
describe.each(PAGES)('%s renders', (_name, node) => {
  it('mounts without throwing', () => {
    expect(() => withRegion(node)).not.toThrow();
  });

  it('has NO interactive element nested inside another', () => {
    const { container } = withRegion(node);
    // <button> inside <a> is invalid HTML. React throws a hydration error and Next's
    // dev overlay then covers the page, so the click never lands - which is exactly
    // how "Book Now" broke.
    expect(container.querySelectorAll('a button')).toHaveLength(0);
    expect(container.querySelectorAll('button a')).toHaveLength(0);
    expect(container.querySelectorAll('a a')).toHaveLength(0);
    expect(container.querySelectorAll('button button')).toHaveLength(0);
  });

  it('gives every control an accessible name', () => {
    const { container } = withRegion(node);
    const unnamed = [...container.querySelectorAll('button, a')].filter((el) => {
      const text = (el.textContent ?? '').trim();
      const label = el.getAttribute('aria-label') ?? '';
      const title = el.getAttribute('title') ?? '';
      return !text && !label && !title;
    });
    expect(unnamed.map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('labels every text input', () => {
    const { container } = withRegion(node);
    const unlabelled = [...container.querySelectorAll('input')].filter((el) => {
      const id = el.getAttribute('id');
      return !(
        (id && container.querySelector(`label[for="${id}"]`))
        || el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
      );
    });
    expect(unlabelled).toHaveLength(0);
  });
});

describe('home page content', () => {
  /**
   * The proposition is asserted by role and level rather than by its exact words,
   * so rewriting the headline is a copy change and not a test failure. What must
   * hold is that the page opens with one h1 that names the thing on offer.
   */
  it('shows the hero proposition', () => {
    withRegion(<Home />);
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/pandit|pooja|puja/i);
  });

  it('offers a search as the first thing in the hero', () => {
    withRegion(<Home />);
    expect(screen.getByRole('combobox', { name: /Search poojas/i })).toBeInTheDocument();
  });

  /**
   * These used to pass on the first synchronous render because "New and noteworthy"
   * was four hardcoded cards. Now every service card comes from the catalogue, so
   * the assertion has to wait for the data — which is also the honest test: before
   * the fetch resolves there are genuinely no services to book.
   */
  it('shows a Book Now once the catalogue loads', async () => {
    withRegion(<Home />);
    expect((await screen.findAllByRole('link', { name: /Book Now/i })).length)
      .toBeGreaterThan(0);
  });

  it('routes every Book Now into the booking flow carrying its ritual', async () => {
    withRegion(<Home />);
    for (const a of await screen.findAllByRole('link', { name: /Book Now/i })) {
      expect(a.getAttribute('href')).toMatch(/^\/book\?ritual=[a-z-]+$/);
    }
  });
});

describe('login page', () => {
  it('offers both sign-in methods', () => {
    withRegion(<LoginPage />);
    expect(screen.getByRole('button', { name: /Phone OTP/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Email & password/i })).toBeInTheDocument();
  });

  it('starts on OTP with the send action disabled until a number is entered', () => {
    withRegion(<LoginPage />);
    expect(screen.getByRole('button', { name: /Send OTP/i })).toBeDisabled();
  });

  it('has a route to registration', () => {
    withRegion(<LoginPage />);
    expect(screen.getByRole('button', { name: /Create an account/i })).toBeInTheDocument();
  });
});

describe('booking page', () => {
  it('renders immediately rather than blanking until an effect runs', () => {
    // Returning null until useEffect meant the server sent an empty document and
    // the user saw a flash of nothing.
    withRegion(<BookPage />);
    expect(screen.getByRole('heading', { name: /Book a pandit/i })).toBeInTheDocument();
  });

  it('shows the three-step rail and the summary panel', () => {
    withRegion(<BookPage />);
    for (const label of ['Service', 'Date & time', 'Confirm']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(/Booking summary/i)).toBeInTheDocument();
  });

  it('is browsable signed out — no redirect to login on mount', () => {
    withRegion(<BookPage />);
    expect(screen.queryByText(/Taking you to sign in/i)).not.toBeInTheDocument();
  });
});
