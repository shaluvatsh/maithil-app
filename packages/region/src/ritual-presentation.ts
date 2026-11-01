/**
 * How a ritual is *shown*, as opposed to what it costs or when it may be booked.
 *
 * These two maps lived inside `apps/web/app/page.tsx`, so the home page had one
 * glyph for Griha Prabesh and `/services`, `/pooja/[slug]` and the booking
 * catalogue each had none — the same ritual wore a different face depending on
 * which screen you reached it from. Search aliases had the same problem: typing
 * "housewarming" worked in the hero and matched nothing in the booking flow's own
 * search box, which is the one you use when you are actually buying.
 *
 * Presentation belongs with the taxonomy it decorates, next to `categories.ts`,
 * for the same reason: both clients and the API need the same answer, and a second
 * copy is a second thing to forget.
 *
 * Deliberately NOT in the database. A glyph is not data a purohit or an admin
 * curates; it changes when the design changes, and putting it in Postgres would
 * mean a migration to fix a typo in an emoji.
 */

/** One glyph per ritual. Duplicates are a bug — two cards then look like one. */
export const RITUAL_EMOJI: Readonly<Record<string, string>> = {
  'griha-prabesh': '🏠',
  'biye': '💒',
  'satyanarayan-puja': '📿',
  'rudrabhishek': '🔱',
  'chandi-paath': '🗡️',
  'rudra-chandi-paath': '⚔️',
  'mahamrityunjay-jaap': '🕉️',
  'annaprashan': '🍚',
  'namkaran': '🌸',
  'upanayan': '🧵',
  'durga-puja': '🛕',
  'durga-puja-ghot': '🪔',
  'kali-puja': '🌺',
  'lakshmi-puja': '🪙',
  'saraswati-puja': '📖',
  'ganesh-puja': '🐘',
  'bastu-puja': '🧭',
  'nabagraha-shanti': '🪐',
  'sraddha': '🙏',
  'tarpan': '💧',
  'halkhata': '📕',
  'jagaddhatri-puja': '🌼',
  'kartik-puja': '🏹',
  'janmashtami-puja': '🦚',
  'shiva-ratri-puja': '🌙',
  'bipodtarini-puja': '🧿',
  'bishwakarma-puja': '⚙️',
  'mangal-chandi-puja': '🔆',
  'annapurna-puja': '🍲',
  'online-aarti': '📹',
  'virtual-consultation': '🗣️',
  'personalised-puja': '✨',
} as const;

const FALLBACK = '🕉️';

export const emojiFor = (slug: string): string => RITUAL_EMOJI[slug] ?? FALLBACK;

/**
 * What people type when they do not know the ritual's name.
 *
 * The catalogue is in Sanskrit and Bengali. Without these, "housewarming" and
 * "baby naming" match nothing at all — and search is the first control on the
 * page, so the control most likely to be used first was the one most likely to
 * dead-end. Matched only, never displayed: the ritual keeps its proper name.
 */
export const RITUAL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'griha-prabesh': [
    'housewarming', 'new house', 'grihapravesh', 'griha prabesh', 'house warming', 'moving in',
  ],
  'biye': ['wedding', 'marriage', 'shaadi', 'vivah', 'bengali wedding'],
  'annaprashan': ['first rice', 'rice ceremony', 'baby food', 'mukhe bhaat', 'annaprasan'],
  'namkaran': ['naming', 'baby name', 'namkaran sanskar'],
  'upanayan': ['thread ceremony', 'sacred thread', 'janeu', 'poite', 'upanayanam'],
  'nabagraha-shanti': ['navagraha', 'planet', 'graha shanti', 'dosha', 'nine planets'],
  'sraddha': ['last rites', 'death anniversary', 'ancestor', 'shraddha', 'funeral'],
  'tarpan': ['ancestor offering', 'pitru', 'tarpanam'],
  'bastu-puja': ['vastu', 'vaastu', 'bastu', 'office opening', 'shop opening'],
  'satyanarayan-puja': ['satyanarayana', 'katha', 'satyanarayn'],
  'durga-puja': ['durga', 'durga puja', 'pujo', 'saptami', 'ashtami', 'nabami', 'dashami'],
  'rudrabhishek': ['shiva', 'shiv abhishek', 'mahadev', 'abhishek'],
  'chandi-paath': ['chandi', 'saptashati', 'durga saptashati', 'devi paath'],
  'rudra-chandi-paath': ['rudra chandi', 'rudrachandi', 'chandi rudra'],
  'mahamrityunjay-jaap': ['mahamrityunjay', 'mrityunjay', 'maha mrityunjaya', 'jaap', 'japa'],
  /*
   * The display name generalised to "New Ledger Puja" (see rituals.kolkata.ts) so a
   * devotee outside Bengal recognises what it is; these keep it findable by the
   * name a Kolkata purohit or devotee would actually type.
   */
  'halkhata': ['new account book', 'business new year', 'hal khata', 'halkhata', 'poila boishakh'],
  'ganesh-puja': ['ganpati', 'ganesha', 'vinayaka'],
  /** Display name generalised to "Sharad Purnima" - the Bengali term stays searchable. */
  'lakshmi-puja': ['kojagari', 'kojagari purnima', 'sharad purnima', 'kojagari lakshmi puja'],
  /** Display name generalised to "Kalash Sthapana" - the Bengali term stays searchable. */
  'durga-puja-ghot': ['ghot', 'ghot puja', 'ghot sthapana', 'kalash sthapana'],
  /** Display name dropped "(Gopal Puja)" - the Bengali term stays searchable. */
  'janmashtami-puja': ['gopal puja', 'krishna janmashtami', 'gokulashtami'],
  /** Display name generalised to "Vishwakarma Puja" - the Bengali spelling stays searchable. */
  'bishwakarma-puja': ['bishwakarma', 'vishwakarma jayanti'],
  'online-aarti': ['aarti online', 'live aarti', 'video aarti'],
  'virtual-consultation': ['ask a pandit', 'consultation', 'talk to purohit'],
  'personalised-puja': ['custom puja', 'bespoke', 'my own puja'],
} as const;

export const aliasesFor = (slug: string): readonly string[] =>
  RITUAL_ALIASES[slug] ?? [];
