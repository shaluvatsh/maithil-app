/**
 * Named slices of the catalogue.
 *
 * Each rail on the home page used to compute its own membership inline — a
 * `.slice(0, 4)` here, a `.filter(deliveryMode === 'virtual')` there — and its
 * "See all" pointed at `/book?browse=1`, which is the whole catalogue in a
 * different order. So a devotee who clicked "See all" under *Most booked* landed
 * on a list that was neither most booked nor in the order they had just been
 * looking at, with no indication of what had happened. The link looked like
 * navigation and behaved like a reset.
 *
 * A collection is therefore one definition used twice: the home rail renders the
 * first `preview` of it, and `/book?collection=<id>` renders all of it under the
 * same title. Adding a rail means adding an entry here, not editing two files.
 */
export interface CatalogueItem {
  slug: string;
  deliveryMode: 'at_home' | 'virtual';
}

export interface Collection {
  id: string;
  title: string;
  subtitle: string;
  /** How many the home page shows before "See all". */
  preview: number;
  /**
   * Generic in the *method*, not the interface, so one `Collection` value works
   * for every shape the catalogue takes. The home page's ritual carries a price
   * band and the booking page's carries a slot span; a collection cares about
   * neither, only about `slug` and `deliveryMode`. Parameterising the interface
   * instead would force a cast at every call site — and a cast here would be
   * exactly the kind of "trust me" that hides a real mismatch later.
   */
  select: <T extends CatalogueItem>(all: readonly T[]) => T[];
}

/**
 * Everything a purohit performs in person, excluding the bespoke offering.
 *
 * `personalised-puja` is shaped per household, so it has no fixed content to
 * advertise in a "most booked" rail and belongs with the noteworthy set.
 */
const inPerson = <T extends CatalogueItem>(all: readonly T[]): T[] =>
  all.filter((r) => r.deliveryMode !== 'virtual' && r.slug !== 'personalised-puja');

export const COLLECTIONS: readonly Collection[] = [
  {
    id: 'popular',
    title: 'Most booked services',
    subtitle: 'Popular choices by families in your city',
    preview: 4,
    select: (all) => inPerson(all),
  },
  {
    id: 'online',
    title: 'New and noteworthy',
    subtitle: 'Remote and personalised services',
    preview: 4,
    /**
     * Deliberately disjoint from `popular`. When the two overlapped, a brand-new
     * service appeared in both, and a rail headed "most booked" was advertising
     * something nobody had booked.
     */
    select: (all) => all.filter((r) =>
      r.deliveryMode === 'virtual' || r.slug === 'personalised-puja'),
  },
  {
    id: 'trending',
    title: 'Most requested services',
    subtitle: 'Frequently booked and trending',
    preview: 4,
    select: (all) => inPerson(all).slice(4),
  },
] as const;

export function getCollection(id: string | null | undefined): Collection | null {
  return COLLECTIONS.find((c) => c.id === id) ?? null;
}

/** The rail's own preview, and the destination that shows the rest of it. */
export function collectionPreview<T extends CatalogueItem>(
  c: Collection, all: readonly T[],
): { items: T[]; href: string; hasMore: boolean } {
  const full = c.select(all);
  return {
    items: full.slice(0, c.preview),
    href: `/book?collection=${c.id}`,
    hasMore: full.length > c.preview,
  };
}
