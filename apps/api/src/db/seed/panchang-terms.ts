/**
 * Panchang term names. No provider gives us Bengali - Prokerala localises to
 * Hindi, Tamil, Telugu and Malayalam only - so these are seeded in-house and
 * signed off by the consulting purohit. See ADR 0009.
 */
export interface TermSeed { key: string; bn: string; hi: string; en: string }

const TITHI_NAMES: Array<[string, string, string, string]> = [
  ['pratipada',   'প্রতিপদ',      'प्रतिपदा',    'Pratipada'],
  ['dwitiya',     'দ্বিতীয়া',     'द्वितीया',    'Dwitiya'],
  ['tritiya',     'তৃতীয়া',      'तृतीया',      'Tritiya'],
  ['chaturthi',   'চতুর্থী',      'चतुर्थी',     'Chaturthi'],
  ['panchami',    'পঞ্চমী',       'पंचमी',       'Panchami'],
  ['sasthi',      'ষষ্ঠী',        'षष्ठी',       'Sasthi'],
  ['saptami',     'সপ্তমী',       'सप्तमी',      'Saptami'],
  ['ashtami',     'অষ্টমী',       'अष्टमी',      'Ashtami'],
  ['nabami',      'নবমী',         'नवमी',        'Navami'],
  ['dashami',     'দশমী',         'दशमी',        'Dashami'],
  ['ekadashi',    'একাদশী',       'एकादशी',      'Ekadashi'],
  ['dwadashi',    'দ্বাদশী',      'द्वादशी',     'Dwadashi'],
  ['trayodashi',  'ত্রয়োদশী',    'त्रयोदशी',    'Trayodashi'],
  ['chaturdashi', 'চতুর্দশী',     'चतुर्दशी',    'Chaturdashi'],
];

export const TITHI_TERMS: TermSeed[] = [
  ...TITHI_NAMES.flatMap(([k, bn, hi, en]) => ([
    { key: `shukla_${k}`, bn: `শুক্লা ${bn}`, hi: `शुक्ल ${hi}`, en: `Shukla ${en}` },
    { key: `krishna_${k}`, bn: `কৃষ্ণা ${bn}`, hi: `कृष्ण ${hi}`, en: `Krishna ${en}` },
  ])),
  { key: 'purnima',   bn: 'পূর্ণিমা',  hi: 'पूर्णिमा',  en: 'Purnima' },
  { key: 'amavasya',  bn: 'অমাবস্যা', hi: 'अमावस्या', en: 'Amavasya' },
];

export const NAKSHATRA_TERMS: TermSeed[] = ([
  ['ashwini','অশ্বিনী','अश्विनी','Ashwini'],
  ['bharani','ভরণী','भरणी','Bharani'],
  ['krittika','কৃত্তিকা','कृत्तिका','Krittika'],
  ['rohini','রোহিণী','रोहिणी','Rohini'],
  ['mrigashira','মৃগশিরা','मृगशिरा','Mrigashira'],
  ['ardra','আর্দ্রা','आर्द्रा','Ardra'],
  ['punarvasu','পুনর্বসু','पुनर्वसु','Punarvasu'],
  ['pushya','পুষ্যা','पुष्य','Pushya'],
  ['ashlesha','অশ্লেষা','अश्लेषा','Ashlesha'],
  ['magha','মঘা','मघा','Magha'],
  ['purva_phalguni','পূর্বফাল্গুনী','पूर्वा फाल्गुनी','Purva Phalguni'],
  ['uttara_phalguni','উত্তরফাল্গুনী','उत्तरा फाल्गुनी','Uttara Phalguni'],
  ['hasta','হস্তা','हस्त','Hasta'],
  ['chitra','চিত্রা','चित्रा','Chitra'],
  ['swati','স্বাতী','स्वाति','Swati'],
  ['vishakha','বিশাখা','विशाखा','Vishakha'],
  ['anuradha','অনুরাধা','अनुराधा','Anuradha'],
  ['jyestha','জ্যেষ্ঠা','ज्येष्ठा','Jyestha'],
  ['mula','মূলা','मूल','Mula'],
  ['purva_ashadha','পূর্বাষাঢ়া','पूर्वाषाढ़ा','Purva Ashadha'],
  ['uttara_ashadha','উত্তরাষাঢ়া','उत्तराषाढ़ा','Uttara Ashadha'],
  ['shravana','শ্রবণা','श्रवण','Shravana'],
  ['dhanishta','ধনিষ্ঠা','धनिष्ठा','Dhanishta'],
  ['shatabhisha','শতভিষা','शतभिषा','Shatabhisha'],
  ['purva_bhadrapada','পূর্বভাদ্রপদ','पूर्वा भाद्रपदा','Purva Bhadrapada'],
  ['uttara_bhadrapada','উত্তরভাদ্রপদ','उत्तरा भाद्रपदा','Uttara Bhadrapada'],
  ['revati','রেবতী','रेवती','Revati'],
] as Array<[string,string,string,string]>).map(([key, bn, hi, en]) => ({ key, bn, hi, en }));

/** Bengali month names, for rendering the Bangabda date on the panchang tab. */
export const BENGALI_MONTHS = [
  'বৈশাখ', 'জ্যৈষ্ঠ', 'আষাঢ়', 'শ্রাবণ', 'ভাদ্র', 'আশ্বিন',
  'কার্তিক', 'অগ্রহায়ণ', 'পৌষ', 'মাঘ', 'ফাল্গুন', 'চৈত্র',
] as const;

/** Bengali numerals, for the purohit app display toggle. */
export const toBengaliNumerals = (s: string | number): string =>
  String(s).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!);
