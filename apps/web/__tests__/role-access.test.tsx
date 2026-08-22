import { describe, it, expect } from 'vitest';
import { canAccess, homeFor, navFor, roleOf, type Role } from '@/lib/nav-model';

const ROLES: Role[] = ['guest', 'devotee', 'pandit', 'admin'];

/**
 * Hiding a link is styling. Refusing a route is access control.
 *
 * The header stopped offering a purohit the "Book" link, and only the header knew:
 * `/book` stayed reachable by typing the URL, by an old bookmark, or by any link in
 * an email, and would happily let a purohit start booking a puja from themselves.
 * The two must come from the same table or they drift.
 */
describe('routes are refused to roles they are not for', () => {
  it('keeps booking to the people who book', () => {
    expect(canAccess('guest', '/book')).toBe(true);
    expect(canAccess('devotee', '/book')).toBe(true);
    expect(canAccess('pandit', '/book')).toBe(false);
    expect(canAccess('admin', '/book')).toBe(false);
  });

  it('keeps the devotee account to devotees', () => {
    expect(canAccess('devotee', '/account')).toBe(true);
    expect(canAccess('pandit', '/account')).toBe(false);
    expect(canAccess('guest', '/account')).toBe(false);
  });

  it('keeps the console to staff and the practice to purohits', () => {
    expect(canAccess('admin', '/admin')).toBe(true);
    expect(canAccess('devotee', '/admin')).toBe(false);
    expect(canAccess('pandit', '/purohit/setup')).toBe(true);
    expect(canAccess('devotee', '/purohit/setup')).toBe(false);
  });

  /** Supply signs up from the public site, so `/purohit` itself stays open. */
  it('leaves the pandit recruitment page public', () => {
    for (const r of ROLES) expect(canAccess(r, '/purohit')).toBe(true);
  });

  it('matches nested paths, not just the prefix itself', () => {
    expect(canAccess('pandit', '/book/anything')).toBe(false);
    expect(canAccess('devotee', '/admin/ledger')).toBe(false);
  });

  /** A path that only shares a prefix as a string is a different route. */
  it('does not close a route that merely starts with the same letters', () => {
    expect(canAccess('pandit', '/bookings-help')).toBe(true);
    expect(canAccess('devotee', '/administration-policy')).toBe(true);
  });

  it('leaves everything unlisted open, including the almanac', () => {
    for (const r of ROLES) {
      expect(canAccess(r, '/panchang')).toBe(true);
      expect(canAccess(r, '/services')).toBe(true);
      expect(canAccess(r, '/pooja/griha-prabesh')).toBe(true);
      expect(canAccess(r, '/')).toBe(true);
    }
  });
});

/**
 * The header and the guard read the same table, so a link can never point somewhere
 * its own role would be turned away from.
 */
describe('the header never offers a route the guard would refuse', () => {
  for (const role of ROLES) {
    it(`${role}: every link is reachable`, () => {
      const nav = navFor(role);
      for (const item of [...nav.links, ...nav.account]) {
        const path = item.href.split('?')[0]!;
        expect(canAccess(role, path), `${role} is offered ${item.href} and refused it`)
          .toBe(true);
      }
      if (nav.activity) {
        expect(canAccess(role, nav.activity.href.split('?')[0]!)).toBe(true);
      }
    });
  }
});

describe('a refused visitor lands somewhere useful', () => {
  it('sends each role to its own home, never to a dead end', () => {
    for (const role of ROLES) {
      const home = homeFor(role);
      expect(canAccess(role, home), `${role} is redirected to a page it cannot see`)
        .toBe(true);
    }
  });

  it('sends a purohit to their jobs and an admin to the console', () => {
    expect(homeFor('pandit')).toBe('/purohit');
    expect(homeFor('admin')).toBe('/admin');
    expect(homeFor('devotee')).toBe('/');
    expect(homeFor('guest')).toBe('/');
  });

  it('treats ops as staff, as the API does', () => {
    expect(roleOf(true, 'ops')).toBe('admin');
    expect(canAccess(roleOf(true, 'ops'), '/admin')).toBe(true);
  });
});
