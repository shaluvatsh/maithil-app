import type { Region } from '../types';

export const kolkata: Region = {
  slug: 'kolkata',
  name: { en: 'Kolkata', native: 'কলকাতা' },
  state: 'West Bengal',
  timezone: 'Asia/Kolkata',
  utcOffsetMinutes: 330,
  coords: { lat: 22.5726, lng: 88.3639 },

  locales: ['bn', 'hi', 'en'],
  script: 'bengali',
  numerals: 'beng',

  // Three, because Kolkata households keep three. The Mithila entry matters because
  // most purohits working here are Maithil Brahmins and they serve Maithil and Bihari
  // households alongside Bengali ones.
  panjikas: [
    {
      id: 'gupta_press', native: 'গুপ্তপ্রেস পঞ্জিকা', english: 'Gupta Press',
      note: 'Surya Siddhanta — the traditional reckoning, followed by most para pujas.',
      calendar: 'amanta', computable: false,
    },
    {
      id: 'bisuddha_siddhanta', native: 'বিশুদ্ধসিদ্ধান্ত পঞ্জিকা', english: 'Bisuddha Siddhanta',
      note: 'Drik Siddhanta — observed positions, followed by Belur Math.',
      calendar: 'amanta', computable: true,
    },
    {
      id: 'mithila', native: 'মিথিলা পঞ্চাঙ্গ', english: 'Mithila Panchang',
      note: 'For Maithil and Bihari households. Purnimant months, so festival dates differ.',
      calendar: 'purnimant', computable: false,
    },
  ],
  defaultPanjika: 'gupta_press',

  slots: [
    { idx: 0, start: '06:00', end: '09:00', labelKey: 'slot.morning' },
    { idx: 1, start: '09:30', end: '12:30', labelKey: 'slot.forenoon' },
    { idx: 2, start: '13:00', end: '16:00', labelKey: 'slot.afternoon' },
    { idx: 3, start: '16:30', end: '19:30', labelKey: 'slot.evening' },
  ],
  travelGapMinutes: 30,
  /** Dense old-city lanes, trams and a river with few crossings. */
  avgSpeedKmph: 16,

  ritualSet: 'bengali',
  era: {
    name: 'Bangabda',
    months: ['বৈশাখ', 'জ্যৈষ্ঠ', 'আষাঢ়', 'শ্রাবণ', 'ভাদ্র', 'আশ্বিন',
             'কার্তিক', 'অগ্রহায়ণ', 'পৌষ', 'মাঘ', 'ফাল্গুন', 'চৈত্র'],
    yearOffset: 593,
    newYear: { month: 4, day: 14 },
  },

  priceIndexBps: 10000,
  currency: 'INR',
  active: true,
};
