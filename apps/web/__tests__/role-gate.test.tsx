import { setPath } from './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, waitFor } from '@testing-library/react';
import { pushed } from './setup';
import { RoleGate } from '@/components/role-gate';
import { isRestricted } from '@/lib/nav-model';

const PAGE = <main id="page">The whole home page</main>;

beforeEach(() => {
  localStorage.clear();
  pushed.length = 0;
});

/**
 * The gate must not blank a page it was never going to refuse.
 *
 * The first version held EVERY route until an effect had read the role out of
 * `localStorage`. On the server there is no `localStorage`, so the server sent the
 * header and the footer with nothing between them: every visitor, on every load and
 * on every back-navigation, saw the footer sitting at the top of the window and then
 * jump down as the content arrived. It also meant `/services` and `/pooja/[slug]` —
 * the two pages that exist to be found in a search engine — were served to crawlers
 * as an empty shell.
 *
 * `renderToStaticMarkup` is the honest assertion here rather than a render + query:
 * it runs no effects, so it sees exactly what leaves the server and exactly what
 * paints first. Testing Library flushes effects inside `act`, which is precisely
 * why the original bug passed a full green suite and was only ever found by a person
 * looking at the screen.
 */
describe('the server sends a complete page', () => {
  const PUBLIC = ['/', '/services', '/panchang', '/pooja/griha-prabesh', '/purohit', '/login'];

  for (const route of PUBLIC) {
    it(`renders ${route} with no role and no waiting`, () => {
      setPath(route);
      const html = renderToStaticMarkup(<RoleGate>{PAGE}</RoleGate>);
      expect(html, `${route} was blanked before the role was known`)
        .toContain('The whole home page');
      expect(html).not.toContain('Checking your account');
    });
  }

  it('agrees with the access table about which routes are open', () => {
    for (const route of PUBLIC) expect(isRestricted(route)).toBe(false);
    for (const route of ['/book', '/account', '/admin', '/purohit/setup']) {
      expect(isRestricted(route)).toBe(true);
    }
  });
});

/**
 * The four closed routes still wait, because there is nothing else they can do: the
 * role is not knowable until the client has mounted. That flash is the whole cost of
 * the fix, and it is paid only by someone already signed in and already on their own
 * page — not by every visitor arriving at the home page.
 */
describe('a restricted route still waits for the role', () => {
  it('holds the page until it knows who is asking', () => {
    setPath('/account');
    const html = renderToStaticMarkup(<RoleGate>{PAGE}</RoleGate>);
    expect(html).not.toContain('The whole home page');
    expect(html).toContain('Checking your account');
  });

  it('lets the right role through once mounted', async () => {
    setPath('/account');
    localStorage.setItem('themaithil.token', 'x');
    localStorage.setItem('themaithil.role', 'devotee');

    render(<RoleGate>{PAGE}</RoleGate>);
    expect(await screen.findByText('The whole home page')).toBeInTheDocument();
    expect(pushed).toEqual([]);
  });

  it('sends the wrong role to its own home instead of showing the page', async () => {
    setPath('/account');
    localStorage.setItem('themaithil.token', 'x');
    localStorage.setItem('themaithil.role', 'pandit');

    render(<RoleGate>{PAGE}</RoleGate>);
    await waitFor(() => expect(pushed).toContain('/purohit'));
    expect(screen.queryByText('The whole home page')).not.toBeInTheDocument();
  });
});
