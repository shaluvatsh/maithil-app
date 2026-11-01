/**
 * Catalogue slugs, mirrored from apps/api/src/db/seed/rituals.kolkata.ts.
 *
 * Duplicated deliberately: packages/region must not depend on the API, and a test
 * that drifts from the seed is exactly what the "orphans" assertion catches.
 */
export const KOLKATA_SLUGS = [
  'satyanarayan-puja', 'griha-prabesh', 'annaprashan', 'upanayan', 'biye',
  'sraddha', 'tarpan', 'durga-puja-ghot', 'kali-puja', 'lakshmi-puja',
  'saraswati-puja', 'ganesh-puja', 'bastu-puja', 'rudrabhishek', 'nabagraha-shanti',
  'bipodtarini-puja', 'mangal-chandi-puja', 'annapurna-puja', 'jagaddhatri-puja',
  'kartik-puja', 'bishwakarma-puja', 'janmashtami-puja', 'shiva-ratri-puja',
  'halkhata', 'namkaran',

  // Remote and personalised. These replaced four hardcoded marketing cards on the
  // home page whose "Book Now" pointed at a catalogue that did not contain them.
  'online-aarti', 'virtual-consultation', 'personalised-puja',

  // Multi-day. A Durga Puja is four days and a full Chandi Paath can be nine
  // (ADR 0006, A0002_multi_day_rituals) — they arrived in the catalogue and in
  // `RITUAL_CATEGORY_MAP`, and this mirror was not updated, so the orphans assertion
  // fired for four slugs that were perfectly correct. `catalogue-parity.test.ts` in
  // apps/api now fails when this list drifts again, which is the half of the safety
  // net that was missing: only the API can see both sides.
  'durga-puja', 'chandi-paath', 'rudra-chandi-paath', 'mahamrityunjay-jaap',
];
