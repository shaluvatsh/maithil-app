import { city, DRIK, BANARAS, MITHILA, TAMIL_VAKYA, SOUTH_SLOTS } from './factory';

/**
 * Pan-India coverage. Each entry is the minimum that genuinely differs; everything
 * else comes from the factory defaults.
 *
 * Coordinates matter more than they look: sunrise shifts about four minutes per
 * degree of longitude, so Guwahati and Ahmedabad are nearly an hour apart. Panchang
 * computed for the wrong city is simply wrong.
 */
export const INDIA = [
  city({ slug: 'delhi', priceIndexBps: 11500, en: 'Delhi NCR', native: 'दिल्ली', state: 'Delhi',
         lat: 28.6139, lng: 77.2090, locales: ['hi', 'en'], script: 'devanagari',
         numerals: 'deva', panjikas: [BANARAS, DRIK], travelGapMinutes: 60 }),

  city({ slug: 'mumbai', priceIndexBps: 12500, en: 'Mumbai', native: 'मुंबई', state: 'Maharashtra',
         lat: 19.0760, lng: 72.8777, locales: ['mr', 'hi', 'en'], script: 'devanagari',
         panjikas: [DRIK, BANARAS], travelGapMinutes: 75, ritualSet: 'west' }),

  city({ slug: 'pune', priceIndexBps: 10500, en: 'Pune', native: 'पुणे', state: 'Maharashtra',
         lat: 18.5204, lng: 73.8567, locales: ['mr', 'hi', 'en'], script: 'devanagari',
         ritualSet: 'west' }),

  city({ slug: 'bengaluru', priceIndexBps: 11500, en: 'Bengaluru', native: 'ಬೆಂಗಳೂರು', state: 'Karnataka',
         lat: 12.9716, lng: 77.5946, locales: ['kn', 'ta', 'te', 'hi', 'en'],
         script: 'kannada', panjikas: [DRIK, TAMIL_VAKYA], slots: SOUTH_SLOTS,
         travelGapMinutes: 60, ritualSet: 'south' }),

  city({ slug: 'chennai', priceIndexBps: 10500, en: 'Chennai', native: 'சென்னை', state: 'Tamil Nadu',
         lat: 13.0827, lng: 80.2707, locales: ['ta', 'te', 'en'], script: 'tamil',
         panjikas: [TAMIL_VAKYA, DRIK], slots: SOUTH_SLOTS, ritualSet: 'south' }),

  city({ slug: 'hyderabad', priceIndexBps: 10500, en: 'Hyderabad', native: 'హైదరాబాద్', state: 'Telangana',
         lat: 17.3850, lng: 78.4867, locales: ['te', 'hi', 'en'], script: 'telugu',
         slots: SOUTH_SLOTS, ritualSet: 'south' }),

  city({ slug: 'ahmedabad', priceIndexBps: 10000, en: 'Ahmedabad', native: 'અમદાવાદ', state: 'Gujarat',
         lat: 23.0225, lng: 72.5714, locales: ['gu', 'hi', 'en'], script: 'gujarati',
         ritualSet: 'west' }),

  city({ slug: 'jaipur', priceIndexBps: 9500, en: 'Jaipur', native: 'जयपुर', state: 'Rajasthan',
         lat: 26.9124, lng: 75.7873, locales: ['hi', 'en'], script: 'devanagari',
         numerals: 'deva', panjikas: [BANARAS, DRIK] }),

  city({ slug: 'lucknow', priceIndexBps: 9000, en: 'Lucknow', native: 'लखनऊ', state: 'Uttar Pradesh',
         lat: 26.8467, lng: 80.9462, locales: ['hi', 'en'], script: 'devanagari',
         numerals: 'deva', panjikas: [BANARAS, DRIK] }),

  city({ slug: 'varanasi', priceIndexBps: 8500, en: 'Varanasi', native: 'वाराणसी', state: 'Uttar Pradesh',
         lat: 25.3176, lng: 82.9739, locales: ['hi', 'en'], script: 'devanagari',
         numerals: 'deva', panjikas: [BANARAS, DRIK], travelGapMinutes: 30 }),

  city({ slug: 'bhubaneswar', priceIndexBps: 9000, en: 'Bhubaneswar', native: 'ଭୁବନେଶ୍ୱର', state: 'Odisha',
         lat: 20.2961, lng: 85.8245, locales: ['or', 'hi', 'en'], script: 'odia',
         ritualSet: 'east' }),

  city({ slug: 'guwahati', priceIndexBps: 9500, en: 'Guwahati', native: 'গুৱাহাটী', state: 'Assam',
         lat: 26.1445, lng: 91.7362, locales: ['bn', 'hi', 'en'], script: 'bengali',
         ritualSet: 'east' }),
] as const;
