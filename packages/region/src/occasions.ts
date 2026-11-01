/**
 * Occasions — the way a household actually arrives.
 *
 * The catalogue is organised the way a purohit thinks: by ritual. A family does not
 * think that way. They know their *situation* — "we are moving into a new flat",
 * "father passed last year", "the business isn't doing well" — and they do not know
 * whether that means Griha Pravesh, Vastu Shanti, Satyanarayan, or all three.
 *
 * Opening with a search box over Sanskrit names asks the devotee to already know the
 * answer they came to find. Every competitor does this; it is the category's largest
 * UX failure and it was ours too.
 *
 * So this maps SITUATION -> RITUALS, with the guidance a knowledgeable relative
 * would give. `RITUAL_CATEGORIES` stays as it is: categories are for browsing,
 * occasions are for arriving. They answer different questions and should not be
 * collapsed into each other.
 *
 * Data, not code — same as regions, categories and slots. A new occasion is an entry
 * here and nothing else changes.
 */
export interface OccasionRitual {
  /** Ritual slug from the catalogue. */
  slug: string;
  /** What this one actually does, in a sentence a non-specialist can act on. */
  does: string;
  /**
   * How strongly it applies:
   *   'core'       — what the occasion normally means
   *   'often-with' — commonly performed alongside, and worth offering
   *   'optional'   — only some families do this
   */
  weight: 'core' | 'often-with' | 'optional';
}

export interface Occasion {
  id: string;
  /** First person, as the devotee would say it. Not a category name. */
  label: string;
  /** One line so the card is self-explanatory without being tapped. */
  blurb: string;
  /**
   * Reuses the matching category's own tile photo (a different variant where two
   * occasions land on the same category, e.g. `new-home` and `new-work` both being
   * "home and new beginnings") rather than a photo of its own - occasions and
   * categories answer different questions, but there is no reason for a devotee to
   * learn two different visual languages for the same underlying catalogue.
   */
  photo: string;
  order: number;
  /**
   * Answers "do I need all of these?" — the question a family always has and
   * nobody in the category answers.
   */
  guidance: string;
  rituals: readonly OccasionRitual[];
}

export const OCCASIONS: readonly Occasion[] = [
  {
    id: 'new-home',
    label: 'We are moving into a new home',
    blurb: 'Entering a new house or flat',
    photo: '/images/categories/home-and-new-beginnings-1.jpg',
    order: 1,
    guidance:
      'Most families do Griha Pravesh on the day they enter. Vastu Puja is separate '
      + 'and addresses the building itself — worth adding if the house is new-built '
      + 'or has been empty. Satyanarayan is often done a few days later as thanks, '
      + 'not on the same day.',
    rituals: [
      { slug: 'griha-prabesh', weight: 'core',
        does: 'The entry itself — kalash, homa and the first cooking in the house.' },
      { slug: 'bastu-puja', weight: 'often-with',
        does: 'Addresses the land and structure. Usual for a newly built house.' },
      { slug: 'satyanarayan-puja', weight: 'optional',
        does: 'Thanksgiving with the katha, commonly a few days after moving in.' },
    ],
  },
  {
    id: 'new-baby',
    label: 'We have had a baby',
    blurb: 'Naming, first rice, first ceremonies',
    photo: '/images/categories/life-ceremonies-1.jpg',
    order: 2,
    guidance:
      'Namkaran comes first, usually in the first weeks. Annaprashan is separate and '
      + 'much later — around six months, when the child first eats rice. You do not '
      + 'need both at once.',
    rituals: [
      { slug: 'namkaran', weight: 'core',
        does: 'Naming ceremony, in the first weeks after birth.' },
      { slug: 'annaprashan', weight: 'core',
        does: 'The first rice, at around six months.' },
    ],
  },
  {
    id: 'ancestors',
    label: 'Remembering someone who has passed',
    blurb: 'Shraddha, tarpan and annual observance',
    photo: '/images/categories/ancestral-rites-1.jpg',
    order: 3,
    guidance:
      'Shraddha is performed at home with pind daan. Tarpan is a shorter water rite, '
      + 'usually at a ghat, and is what most families do during Pitri Paksha and on '
      + 'Mahalaya. If this is the first year, Shraddha is the one you want.',
    rituals: [
      { slug: 'sraddha', weight: 'core',
        does: 'Full shraddha at home, with pind daan.' },
      { slug: 'tarpan', weight: 'often-with',
        does: 'Water offering, shorter, usually at a ghat. Mahalaya and Pitri Paksha.' },
    ],
  },
  {
    id: 'new-work',
    label: 'Starting something new at work',
    blurb: 'A new shop, office, vehicle or ledger',
    photo: '/images/categories/home-and-new-beginnings-2.jpg',
    order: 4,
    guidance:
      'The new ledger puja is tied to the Bengali new year (Poila Boishakh) and is '
      + 'date-fixed. For a new shop or office opening on any other day, Lakshmi Puja '
      + 'is the usual choice. Vishwakarma is for tools, machinery and vehicles.',
    rituals: [
      { slug: 'lakshmi-puja', weight: 'core',
        does: 'Prosperity for a new venture, premises or ledger.' },
      { slug: 'bishwakarma-puja', weight: 'often-with',
        does: 'For tools, machines and vehicles.' },
      { slug: 'halkhata', weight: 'optional',
        does: 'The new account book, blessed on the Bengali new year.' },
    ],
  },
  {
    id: 'peace-and-remedy',
    label: 'Something is not going well',
    blurb: 'Health, obstacles, or an astrologer has suggested a remedy',
    photo: '/images/categories/peace-and-remedies-1.jpg',
    order: 5,
    guidance:
      'If an astrologer named a specific graha, Nabagraha Shanti is the one. '
      + 'Rudrabhishek is the general remedy most families reach for and needs no '
      + 'chart. Mangal Chandi is traditionally for the wellbeing of the family.',
    rituals: [
      { slug: 'nabagraha-shanti', weight: 'core',
        does: 'Planetary shanti. Ask your astrologer which graha before booking.' },
      { slug: 'rudrabhishek', weight: 'core',
        does: 'Abhishek to Shiva. The general-purpose remedy; no chart needed.' },
      { slug: 'mangal-chandi-puja', weight: 'often-with',
        does: 'For the wellbeing of the household, traditionally on a Tuesday.' },
    ],
  },
  {
    id: 'coming-of-age',
    label: 'A thread ceremony or a wedding',
    blurb: 'Upanayan and wedding ceremonies',
    photo: '/images/categories/life-ceremonies-2.jpg',
    order: 6,
    guidance:
      'Both run for several hours and need booking well ahead — the date is usually '
      + 'fixed by your family astrologer first. Tell us that date and we will match a '
      + 'purohit who performs your vidhi.',
    rituals: [
      { slug: 'upanayan', weight: 'core',
        does: 'Sacred thread ceremony. Half a day, with homa.' },
      { slug: 'biye', weight: 'core',
        does: 'Full Hindu wedding vidhi. Several hours; book well in advance.' },
    ],
  },
  {
    id: 'festival',
    label: 'It is a festival',
    blurb: 'Durga, Kali, Lakshmi, Saraswati and the rest of the year',
    photo: '/images/categories/festival-pujas-1.jpg',
    order: 7,
    guidance:
      'Festival dates are fixed by the panchang, so availability goes quickly — '
      + 'Durga Puja and Kali Puja purohits are usually booked weeks ahead.',
    rituals: [
      { slug: 'durga-puja-ghot', weight: 'core',
        does: 'Kalash sthapana at home, across the four days of the puja.' },
      { slug: 'kali-puja', weight: 'core',
        does: 'Performed at home on Amavasya night, so the slot runs late.' },
      { slug: 'lakshmi-puja', weight: 'core',
        does: 'Lakshmi Puja on Sharad Purnima, the full moon after Durga Puja.' },
      { slug: 'saraswati-puja', weight: 'core',
        does: 'Vasant Panchami, with hatekhori for children starting to write.' },
      { slug: 'ganesh-puja', weight: 'often-with',
        does: 'Done before most other rites, and on its own at Chaturthi.' },
      { slug: 'jagaddhatri-puja', weight: 'optional',
        does: 'Kartik month. Followed most closely by Chandannagar households.' },
    ],
  },
  {
    id: 'online',
    label: 'I cannot be there in person',
    blurb: 'Join by video, from anywhere',
    photo: '/images/categories/online-services-1.jpg',
    order: 8,
    guidance:
      'No purohit travels and there is nothing to arrange at your end. Useful if you '
      + 'are away from home, or arranging something for family in another city.',
    rituals: [
      { slug: 'online-aarti', weight: 'core', does: 'Live aarti by video.' },
      { slug: 'virtual-consultation', weight: 'core',
        does: 'Talk to a purohit before deciding what you need.' },
    ],
  },
] as const;

export type OccasionId = (typeof OCCASIONS)[number]['id'];

export const OCCASION_IDS = OCCASIONS.map((o) => o.id);

export const getOccasion = (id: string): Occasion | undefined =>
  OCCASIONS.find((o) => o.id === id);

/** Slugs an occasion suggests, most relevant first. */
export const ritualsForOccasion = (id: string): string[] => {
  const order = { core: 0, 'often-with': 1, optional: 2 } as const;
  return [...(getOccasion(id)?.rituals ?? [])]
    .sort((a, b) => order[a.weight] - order[b.weight])
    .map((r) => r.slug);
};
