import type { Region } from '../types';

/**
 * Mithila region. The natural second city, because the supply is already Maithil.
 *
 * Note what differs from Kolkata beyond the obvious: purnimant calendar, Devanagari
 * script (so a different font subset), Vikram Samvat era, and an earlier first slot
 * because summer here starts hotter earlier.
 */
export const patna: Region = {
  slug: 'patna',
  name: { en: 'Patna', native: 'पटना' },
  state: 'Bihar',
  timezone: 'Asia/Kolkata',
  utcOffsetMinutes: 330,
  coords: { lat: 25.5941, lng: 85.1376 },

  locales: ['hi', 'mai', 'en'],
  script: 'devanagari',
  numerals: 'deva',

  panjikas: [
    {
      id: 'mithila', native: 'मिथिला पंचांग', english: 'Mithila Panchang',
      note: 'Calculated for Mithila. Purnimant months.',
      calendar: 'purnimant', computable: false,
    },
    {
      id: 'vikram_banaras', native: 'बनारसी पंचांग', english: 'Banaras Panchang',
      note: 'Vikram Samvat, widely followed across the Hindi belt.',
      calendar: 'purnimant', computable: false,
    },
    /**
     * Patna listed only hand-entered almanacs, so nothing here could ever be
     * computed — and under ADR 0003 nothing hand-entered has been entered yet.
     * Patna's panchang was therefore unbuildable by construction, not merely
     * unbuilt, and no amount of running the nightly job would have produced one.
     *
     * Drik is offered as the third option rather than promoted to default:
     * Mithila remains what these households actually follow, and substituting a
     * different tradition silently would be worse than showing nothing. This is
     * the one we can compute today, marked as such in the picker.
     */
    {
      id: 'drik_generic', native: 'दृक् पंचांग', english: 'Drik Panchang',
      note: 'Observed planetary positions, computed for Patna.',
      calendar: 'purnimant', computable: true,
    },
  ],
  defaultPanjika: 'mithila',

  slots: [
    { idx: 0, start: '05:30', end: '08:30', labelKey: 'slot.morning' },
    { idx: 1, start: '09:00', end: '12:00', labelKey: 'slot.forenoon' },
    { idx: 2, start: '12:30', end: '15:30', labelKey: 'slot.afternoon' },
    { idx: 3, start: '16:00', end: '19:00', labelKey: 'slot.evening' },
  ],
  travelGapMinutes: 30,
  /** Smaller and flatter than Kolkata, but few through-roads. */
  avgSpeedKmph: 18,

  ritualSet: 'maithil',
  era: {
    name: 'Vikram Samvat',
    months: ['चैत्र', 'वैशाख', 'ज्येष्ठ', 'आषाढ़', 'श्रावण', 'भाद्रपद',
             'आश्विन', 'कार्तिक', 'मार्गशीर्ष', 'पौष', 'माघ', 'फाल्गुन'],
    yearOffset: -57,
    newYear: { month: 3, day: 22 },
  },

  priceIndexBps: 8500,
  currency: 'INR',
  active: true,
};
