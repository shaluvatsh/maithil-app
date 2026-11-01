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
  /**
   * The marketing footer and the "Chat with us" float — the shop's chrome.
   *
   * The header has branched per role since this file existed, but the footer and
   * the support float were rendered unconditionally in `layout.tsx`. So an ops
   * admin reading the ledger got "Something wrong with a booking? WhatsApp us", a
   * Book-a-pooja link farm and fourteen city chips; a purohit got the same, plus a
   * float that overlapped his own payout form on a phone. Both are addressed to
   * someone buying a puja, and neither of them is.
   *
   * Here rather than in the layout so "what does this role see" stays one table.
   */
  consumerChrome: boolean;
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
  /*
   * Community sits in the browse group, not behind sign-in.
   *
   * A question a signed-out stranger can read is the entire acquisition argument
   * for having built it — hiding it behind an account would leave the one surface
   * search engines can index unreachable from the header.
   */
  { href: '/community', label: 'Community', mobile: true },
  /*
   * Events sits beside Community rather than inside it.
   *
   * A devotee looking for "what is on near me this weekend" is not browsing a
   * question board, and burying a calendar one level down inside a forum is how it
   * stops being found.
   */
  { href: '/events', label: 'Events', mobile: true },
  /*
   * Learn is the SEO asset ADR 0008 cut when it dropped `devotee-web`, living inside
   * the app that already exists — so it has to be reachable from the header for a
   * signed-out visitor, which is most of who arrives on it.
   */
  { href: '/learn', label: 'Learn', mobile: true },
];

/**
 * What a purohit sees depends on whether they are APPROVED, not only on their role.
 *
 * Before approval the setup wizard is the product — `PurohitOnboarding` replaces the
 * dashboard entirely, because a job inbox that cannot receive a job is three dead
 * panels — so "My practice" belongs in the main bar where it cannot be missed.
 *
 * After approval it is a settings page touched twice a year, and a purohit's main bar
 * is three links that should be the things they use daily: jobs, panchang, community.
 * So it moves to the avatar dropdown. Same argument that took the language picker out
 * of the header: permanent chrome is for repeated actions.
 *
 * `kycStatus` is optional so every existing caller keeps working; absent is treated as
 * unapproved, which is the safe default — showing the setup link to somebody who no
 * longer needs it costs a line of chrome, hiding it from somebody who does costs them
 * the only route to becoming bookable.
 */
export function navFor(role: Role, kycStatus?: string | null): NavModel {
  const approved = kycStatus === 'verified';
  switch (role) {
    case 'pandit':
      return {
        role,
        links: [
          { href: '/purohit', label: 'My jobs', mobile: true },
          // Unapproved: the one screen that makes them bookable, in the main bar.
          ...(approved ? [] : [{ href: '/purohit/setup', label: 'My practice', mobile: true }]),
          { href: '/panchang', label: 'Panchang', mobile: true },
          // Answering is how a purohit builds a reputation here rather than
          // somewhere else, which is the supply-retention half of ADR 0014.
          { href: '/community', label: 'Community', mobile: true },
          // A purohit fills otherwise-empty time with a group event — the one thing
          // events do that bookings cannot. ADR 0015.
          { href: '/events', label: 'Events', mobile: true },
          // Writing and reviewing is the other half of the switching cost: a purohit
          // with checked articles to their name has something they cannot take away.
          { href: '/learn', label: 'Learn', mobile: true },
        ],
        /*
         * Empty while onboarding — the wizard at `/purohit/setup` is the whole
         * product then, and it is already in the main bar where it cannot be
         * missed. Once approved, this is the profile menu proper: everything that
         * is not a daily action moves here, which is what let `/purohit` and
         * `/purohit/setup` stop being two of the longest pages in the product.
         *
         * Each one used to be a SECTION stacked on a bigger page rather than a
         * destination: the dashboard sat above the job list a purohit opened every
         * day, and services, rates, payout and calendar sat stacked on one setup
         * page a purohit had to scroll all of to change one field. Splitting them
         * is what "reduces complexity" literally means here — fewer things visible
         * on any one screen, each reachable by name rather than by scrolling.
         *
         * "My jobs" is deliberately NOT duplicated here. It is the one thing used
         * daily and it already has the main bar's best seat; repeating it in the
         * dropdown would be the same destination offered twice, which is the exact
         * redundancy this split is removing from the rest of the page.
         */
        account: approved
          ? [
            { href: '/purohit/dashboard', label: 'Dashboard' },
            { href: '/purohit/setup', label: 'My practice' },
            { href: '/purohit/rates', label: 'Services & rates' },
            { href: '/purohit/payouts', label: 'Payouts' },
          ]
          : [],
        activity: {
          href: '/purohit',
          label: 'My jobs',
          countLabel: (n) => (n > 0 ? `My jobs, ${n} upcoming` : 'My jobs'),
        },
        showCity: false,
        consumerChrome: false,
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
        consumerChrome: false,
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
        consumerChrome: true,
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
        consumerChrome: true,
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
