/**
 * Ritual categories.
 *
 * Shared config rather than a hardcoded list in the web app, because both the API
 * (filtering, counts) and every client need the same taxonomy, and a new region may
 * order or rename them.
 *
 * The taxonomy is built around WHY a household is booking, not around which deity is
 * worshipped. "My daughter's rice ceremony", "we are moving house", "it is Durga
 * Puja", "father's shraddha", "the astrologer said do a shanti" — those are the five
 * distinct intents, and a family arrives already knowing which one they are in.
 *
 * Categories are DISJOINT: every ritual has exactly one. Overlapping categories are
 * how a browse experience turns into the same list five times.
 */
export interface RitualCategory {
  id: string;
  en: string;
  /** One line telling the user what belongs here. */
  blurb: string;
  emoji: string;
  /** Background for the tile. Flat where the emoji already carries colour. */
  tint: string;
  order: number;
}

export const RITUAL_CATEGORIES: readonly RitualCategory[] = [
  {
    id: 'life-ceremonies', en: 'Life Ceremonies',
    blurb: 'Naming, first rice, sacred thread, marriage',
    emoji: '👶', tint: 'linear-gradient(135deg,#F472B6,#DB2777)', order: 1,
  },
  {
    id: 'home-and-new-beginnings', en: 'Home & New Beginnings',
    blurb: 'Moving in, vastu, a new shop or vehicle',
    emoji: '🏠', tint: 'linear-gradient(135deg,#FB923C,#EA580C)', order: 2,
  },
  {
    id: 'festival-pujas', en: 'Festival Pujas',
    blurb: 'Durga, Kali, Lakshmi, Saraswati and the rest of the year',
    emoji: '🪔', tint: 'linear-gradient(135deg,#FBBF24,#D97706)', order: 3,
  },
  {
    id: 'ancestral-rites', en: 'Ancestral Rites',
    blurb: 'Shraddha, tarpan and post-funerary observance',
    emoji: '🙏', tint: 'linear-gradient(135deg,#94A3B8,#475569)', order: 4,
  },
  {
    id: 'peace-and-remedies', en: 'Peace & Remedies',
    blurb: 'Graha shanti, abhishek and dosha remediation',
    emoji: '🪐', tint: 'linear-gradient(135deg,#818CF8,#4F46E5)', order: 5,
  },
  /**
   * The only category defined by HOW it is delivered rather than why it is booked,
   * which breaks the rule the other five follow. It earns the exception: nothing
   * about a remote service is comparable to a purohit at your door — no travel, no
   * samagri, no address — and burying it inside "Festival Pujas" would mislead a
   * devotee into expecting someone to arrive.
   */
  {
    id: 'online-services', en: 'Online Services',
    blurb: 'Aarti and consultation by video, wherever you are',
    emoji: '💻', tint: 'linear-gradient(135deg,#38BDF8,#0284C7)', order: 6,
  },
] as const;

export type RitualCategoryId = (typeof RITUAL_CATEGORIES)[number]['id'];

export const CATEGORY_IDS = RITUAL_CATEGORIES.map((c) => c.id);

export const getCategory = (id: string): RitualCategory | undefined =>
  RITUAL_CATEGORIES.find((c) => c.id === id);

/**
 * Ritual slug -> category. The single source of truth for what belongs where; the
 * seed reads it, and a test asserts every seeded ritual appears here exactly once.
 */
export const RITUAL_CATEGORY_MAP: Record<string, RitualCategoryId> = {
  // Life ceremonies — samskara
  'annaprashan': 'life-ceremonies',
  'namkaran': 'life-ceremonies',
  'upanayan': 'life-ceremonies',
  'biye': 'life-ceremonies',

  // Home and new beginnings
  'griha-prabesh': 'home-and-new-beginnings',
  'bastu-puja': 'home-and-new-beginnings',
  'halkhata': 'home-and-new-beginnings',
  'bishwakarma-puja': 'home-and-new-beginnings',
  'ganesh-puja': 'home-and-new-beginnings',

  // Festival pujas
  'durga-puja-ghot': 'festival-pujas',
  'kali-puja': 'festival-pujas',
  'lakshmi-puja': 'festival-pujas',
  'saraswati-puja': 'festival-pujas',
  'jagaddhatri-puja': 'festival-pujas',
  'kartik-puja': 'festival-pujas',
  'janmashtami-puja': 'festival-pujas',
  'shiva-ratri-puja': 'festival-pujas',
  'bipodtarini-puja': 'festival-pujas',
  'satyanarayan-puja': 'festival-pujas',

  // Ancestral rites
  'sraddha': 'ancestral-rites',
  'tarpan': 'ancestral-rites',

  // Peace and remedies
  'nabagraha-shanti': 'peace-and-remedies',
  'rudrabhishek': 'peace-and-remedies',
  'mangal-chandi-puja': 'peace-and-remedies',
  'annapurna-puja': 'peace-and-remedies',
  'personalised-puja': 'peace-and-remedies',

  // Online
  'online-aarti': 'online-services',
  'virtual-consultation': 'online-services',
};

/** Fallback for a ritual added without a mapping, so nothing vanishes from browse. */
export const DEFAULT_CATEGORY: RitualCategoryId = 'festival-pujas';

export const categoryFor = (slug: string): RitualCategoryId =>
  RITUAL_CATEGORY_MAP[slug] ?? DEFAULT_CATEGORY;
