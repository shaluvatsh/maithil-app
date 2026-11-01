/**
 * Photo resolution for a ritual card, shared by every page that renders one
 * (`/`, `/book`, `/services`) — this used to be declared independently in
 * each, and the first time a second real photo arrived it had to be added
 * to two different `RITUAL_IMAGES` sets by hand. One list now; add a slug
 * once its photo exists at `/public/images/rituals/{slug}.jpg` and every
 * page picks it up.
 */
export const RITUAL_IMAGES = new Set([
  'satyanarayan-puja',
  'annaprashan',
  'upanayan',
  'biye',
  'durga-puja-ghot',
]);

/**
 * One of four candidate photos per category, assigned by the ritual's rank
 * within its own category (sorted by slug) rather than an independent hash
 * per ritual — so two rituals in the same category never land on the same
 * photo by chance, the way Annaprashan and Upanayan once did sitting side by
 * side. Only the fifth-plus ritual in a category with more than four ever
 * repeats a photo, which is the honest limit of four source photos, not a bug.
 */
export function ritualImageVariants(
  rituals: readonly { slug: string; category: string }[],
): Map<string, number> {
  const byCategory = new Map<string, string[]>();
  for (const r of rituals) {
    const list = byCategory.get(r.category);
    if (list) list.push(r.slug); else byCategory.set(r.category, [r.slug]);
  }
  const variant = new Map<string, number>();
  for (const [, slugs] of byCategory) {
    slugs.sort();
    slugs.forEach((slug, i) => variant.set(slug, (i % 4) + 1));
  }
  return variant;
}

/** The image path for one ritual, given the variant map computed above. */
export function ritualImagePath(
  ritual: { slug: string; category: string },
  variants: Map<string, number>,
): string {
  if (RITUAL_IMAGES.has(ritual.slug)) return `/images/rituals/${ritual.slug}.jpg`;
  return `/images/categories/${ritual.category}-${variants.get(ritual.slug) ?? 1}.jpg`;
}
