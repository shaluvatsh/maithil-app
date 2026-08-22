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
];
