/**
 * What the header contains, per role.
 *
 * The header branched on one boolean, `isPandit`, which meant there were two
 * surfaces for four kinds of visitor. An admin got the devotee header — Book,
 * Panchang, For Pandits — and no link to the console they had signed in to use, so
 * the only way to reach `/admin` was to type it. A signed-out visitor got a
 * bookings icon with nothing behind it. And a purohit was offered a city picker,
 * although their city is where their practice is registered and changing it in the
 * header does nothing for them.
 *
 * A pure function rather than JSX conditionals: "does an admin ever see the
 * devotee's booking links" is then a question a test can ask, instead of one you
 * answer by reading four nested ternaries.
 */
export type Role = 'guest' | 'devotee' | 'pandit' | 'admin';

export interface NavItem {
  href: string;
  label: string;
  /** Shown in the compact mobile sheet as well as the desktop bar. */
  mobile?: boolean;
}

export interface NavModel {
  role: Role;
  /** The main bar. */
  links: NavItem[];
  /** Items in the avatar dropdown, above Sign out. */
  account: NavItem[];
  /** Where the calendar icon goes, and what it counts. Null hides the icon. */
  activity: { href: string; label: string; countLabel: (n: number) => string } | null;
  /**
   * A city is a devotee's shopping context. For a purohit it is a property of
   * their registration, changed in their profile, and for an admin it is not a
   * personal setting at all.
   */
  showCity: boolean;
  /** The word under their name in the dropdown. */
  roleLabel: string | null;
}

export function roleOf(signedIn: boolean, role: string | null | undefined): Role {
  if (!signedIn) return 'guest';
  if (role === 'pandit') return 'pandit';
  if (role === 'admin' || role === 'ops') return 'admin';
  return 'devotee';
}

const BROWSE: NavItem[] = [
  { href: '/services', label: 'Services', mobile: true },
  { href: '/book', label: 'Book', mobile: true },
  { href: '/panchang', label: 'Panchang', mobile: true },
];

export function navFor(role: Role): NavModel {
  switch (role) {
    case 'pandit':
      return {
        role,
        links: [
          { href: '/purohit', label: 'My jobs', mobile: true },
          { href: '/purohit/setup', label: 'My practice', mobile: true },
          { href: '/panchang', label: 'Panchang', mobile: true },
        ],
        /**
         * Empty, and deliberately so.
         *
         * The dropdown listed "My jobs" and "Profile & availability", both of which
         * the header bar already carries — the same two destinations offered twice,
         * under two different names, which reads as a rendering fault rather than
         * as convenience. A purohit's whole product is three links; there is no
         * separate account surface to put behind an avatar, so the menu is their
         * name and Sign out.
         */
        account: [],
        activity: {
          href: '/purohit',
          label: 'My jobs',
          countLabel: (n) => (n > 0 ? `My jobs, ${n} upcoming` : 'My jobs'),
        },
        showCity: false,
        roleLabel: 'Pandit',
      };

    case 'admin':
      /**
       * Everything here is operational. An admin who wants to book a puja can use
       * the site as a devotee, but the header should open on the console — that is
       * why they signed in.
       */
      return {
        role,
        links: [
          { href: '/admin', label: 'Console', mobile: true },
          { href: '/admin?tab=verify', label: 'Approvals', mobile: true },
          { href: '/panchang', label: 'Panchang', mobile: true },
        ],
        // Same reasoning as the purohit: both of these are in the bar already.
        account: [],
        activity: null,
        showCity: false,
        roleLabel: 'Staff',
      };

    case 'devotee':
      return {
        role,
        links: BROWSE,
        account: [
          { href: '/account?tab=bookings', label: 'My bookings' },
          { href: '/account?tab=profile', label: 'Profile' },
          { href: '/account?tab=addresses', label: 'Addresses' },
          { href: '/account?tab=preferences', label: 'Panjika preference' },
        ],
        activity: {
          href: '/account',
          label: 'My bookings',
          countLabel: (n) => (n > 0 ? `My bookings, ${n} upcoming` : 'My bookings'),
        },
        showCity: true,
        roleLabel: null,
      };

    default:
      /**
       * A guest is being invited in, not managed. No bookings icon — it counted
       * bookings that cannot exist and led to a login wall dressed as a feature —
       * and "For Pandits" belongs here, because supply signs up from the public
       * site and nowhere else.
       */
      return {
        role: 'guest',
        links: [...BROWSE, { href: '/purohit', label: 'For Pandits', mobile: true }],
        account: [],
        activity: null,
        showCity: true,
        roleLabel: null,
      };
  }
}

/**
 * Which roles a route is FOR.
 *
 * The header already knew that a purohit has no use for "Book" — but only the
 * header knew. `/book` stayed reachable by typing the URL, by an old bookmark, or
 * by any link in an email, and it would happily let a purohit start booking a puja
 * from themselves. Hiding a link is styling; refusing a route is access control,
 * and the two must come from the same table or they drift.
 *
 * Prefix-matched and deliberately sparse: anything not listed is public. Adding a
 * closed route means adding a line here, not remembering to guard a page.
 */
const ROUTE_ROLES: ReadonlyArray<{ prefix: string; roles: readonly Role[] }> = [
  // Booking is the devotee product. A purohit booking a puja from themselves and
  // an admin doing it from the console are both support tickets waiting to happen.
  { prefix: '/book', roles: ['guest', 'devotee'] },
  { prefix: '/account', roles: ['devotee'] },
  { prefix: '/purohit/setup', roles: ['pandit'] },
  { prefix: '/admin', roles: ['admin'] },
];

const ruleFor = (path: string) =>
  ROUTE_ROLES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));

export function canAccess(role: Role, path: string): boolean {
  const rule = ruleFor(path);
  return !rule || rule.roles.includes(role);
}

/**
 * Is this route restricted at all?
 *
 * The gate needs to know this BEFORE it knows the role, because the role can only
 * be read from `localStorage` after mount. Without it the gate had to wait, and
 * waiting meant rendering nothing — on the server and on first paint — for every
 * page including the public ones. See components/role-gate.tsx.
 */
export const isRestricted = (path: string): boolean => ruleFor(path) !== undefined;

/** Where to send someone who cannot be here. Their own home, not a dead end. */
export function homeFor(role: Role): string {
  switch (role) {
    case 'pandit': return '/purohit';
    case 'admin': return '/admin';
    default: return '/';
  }
}
