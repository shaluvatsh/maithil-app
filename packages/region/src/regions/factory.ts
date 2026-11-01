import type { Region, Panjika, SlotDef, Script, Locale, NumeralSystem } from '../types';

/**
 * Most cities differ only in coordinates, language and which almanac they keep.
 * The factory supplies the defaults so a new city is a handful of lines rather than
 * a hundred - which is the difference between "pan-India configurable" on a slide
 * and in the codebase.
 */
export const DRIK: Panjika = {
  id: 'drik_generic', native: 'दृक् पंचांग', english: 'Drik Panchang',
  note: 'Observed planetary positions, computed for your city.',
  calendar: 'amanta', computable: true,
};
export const BANARAS: Panjika = {
  id: 'vikram_banaras', native: 'बनारसी पंचांग', english: 'Banaras Panchang',
  note: 'Vikram Samvat, widely followed across the Hindi belt.',
  calendar: 'purnimant', computable: false,
};
export const MITHILA: Panjika = {
  id: 'mithila', native: 'मिथिला पंचांग', english: 'Mithila Panchang',
  note: 'For Maithil and Bihari households. Purnimant months.',
  calendar: 'purnimant', computable: false,
};
export const TAMIL_VAKYA: Panjika = {
  id: 'tamil_vakya', native: 'வாக்கிய பஞ்சாங்கம்', english: 'Vakya Panchangam',
  note: 'Traditional Tamil reckoning.',
  calendar: 'amanta', computable: false,
};

/** Four three-hour blocks with a half-hour gap. The north-Indian default. */
export const STANDARD_SLOTS: SlotDef[] = [
  { idx: 0, start: '06:00', end: '09:00', labelKey: 'slot.morning' },
  { idx: 1, start: '09:30', end: '12:30', labelKey: 'slot.forenoon' },
  { idx: 2, start: '13:00', end: '16:00', labelKey: 'slot.afternoon' },
  { idx: 3, start: '16:30', end: '19:30', labelKey: 'slot.evening' },
];

/** Southern muhurtas favour very early morning, so the day opens at brahma muhurta. */
export const SOUTH_SLOTS: SlotDef[] = [
  { idx: 0, start: '04:30', end: '07:00', labelKey: 'slot.brahma' },
  { idx: 1, start: '07:30', end: '10:30', labelKey: 'slot.morning' },
  { idx: 2, start: '11:00', end: '14:00', labelKey: 'slot.forenoon' },
  { idx: 3, start: '14:30', end: '17:30', labelKey: 'slot.afternoon' },
  { idx: 4, start: '18:00', end: '20:30', labelKey: 'slot.evening' },
];

export interface CitySpec {
  slug: string;
  en: string;
  native: string;
  state: string;
  lat: number;
  lng: number;
  locales: Locale[];
  script: Script;
  numerals?: NumeralSystem;
  panjikas?: Panjika[];
  slots?: SlotDef[];
  travelGapMinutes?: number;
  avgSpeedKmph?: number;
  ritualSet?: string;
  priceIndexBps?: number;
  active?: boolean;
}

export function city(spec: CitySpec): Region {
  const panjikas = spec.panjikas ?? [DRIK, BANARAS];
  return {
    slug: spec.slug,
    name: { en: spec.en, native: spec.native },
    state: spec.state,
    timezone: 'Asia/Kolkata',
    utcOffsetMinutes: 330,
    coords: { lat: spec.lat, lng: spec.lng },
    locales: spec.locales,
    script: spec.script,
    numerals: spec.numerals ?? 'latn',
    panjikas,
    defaultPanjika: panjikas[0]!.id,
    slots: spec.slots ?? STANDARD_SLOTS,
    travelGapMinutes: spec.travelGapMinutes ?? 45,
    // 18 km/h: slow on purpose. It is applied to a straight-line distance, so it
    // must cover the road detour as well as the traffic.
    avgSpeedKmph: spec.avgSpeedKmph ?? 18,
    ritualSet: spec.ritualSet ?? 'north',
    priceIndexBps: spec.priceIndexBps ?? 10000,
    currency: 'INR',
    active: spec.active ?? true,
  };
}
