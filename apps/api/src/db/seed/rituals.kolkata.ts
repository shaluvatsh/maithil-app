/**
 * Kolkata launch catalogue - 25 rituals.
 *
 * NOT the generic North/West Indian list from the PRD. A Kolkata purohit is asked
 * for Annaprashan, not Namkaran; Upanayan, not Janeu; Halkhata every Poila Boishakh.
 * Bengali is the PRIMARY locale here - a 55-year-old purohit will use the app in
 * Bengali or not at all. See ADR 0009.
 *
 * durationMin drives slotSpan (3h slots): anything over ~170 min needs two.
 * Prices are Kolkata dakshina bands in paise, illustrative - validate with the
 * consulting purohit before seeding production.
 */

export interface RitualSeed {
  slug: string;
  durationMin: number;
  slotSpan: number;
  muhuratSensitive: boolean;
  bandMin: number; bandMax: number; bandDefault: number;
  names: { bn: string; hi: string; en: string };
  short: { bn: string; en: string };
  /**
   * Where it happens. Omitted means the purohit comes to you, which is true of all
   * 25 traditional rituals. Virtual services have no travel and no samagri.
   */
  deliveryMode?: 'at_home' | 'virtual';
}

const R = (n: number) => n * 100; // rupees -> paise

export const KOLKATA_RITUALS: RitualSeed[] = [
  { slug: 'satyanarayan-puja', durationMin: 120, slotSpan: 1, muhuratSensitive: false,
    bandMin: R(1100), bandMax: R(2500), bandDefault: R(1500),
    names: { bn: 'সত্যনারায়ণ পূজা', hi: 'सत्यनारायण पूजा', en: 'Satyanarayan Puja' },
    short: { bn: 'সিন্নি সহ পূর্ণাঙ্গ সত্যনারায়ণ কথা ও পূজা',
             en: 'Full Satyanarayan katha and puja with sinni' } },

  { slug: 'griha-prabesh', durationMin: 180, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(2100), bandMax: R(5100), bandDefault: R(3100),
    names: { bn: 'গৃহপ্রবেশ', hi: 'गृह प्रवेश', en: 'Griha Prabesh' },
    short: { bn: 'নতুন বাড়িতে প্রবেশের পূজা ও হোম',
             en: 'House-warming puja with homa' } },

  { slug: 'annaprashan', durationMin: 150, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(2100), bandMax: R(4100), bandDefault: R(2500),
    names: { bn: 'অন্নপ্রাশন (মুখেভাত)', hi: 'अन्नप्राशन', en: 'Annaprashan (Mukhe Bhaat)' },
    short: { bn: 'শিশুর প্রথম অন্নগ্রহণের অনুষ্ঠান',
             en: "Baby's first rice ceremony" } },

  { slug: 'upanayan', durationMin: 300, slotSpan: 2, muhuratSensitive: true,
    bandMin: R(5100), bandMax: R(15100), bandDefault: R(8100),
    names: { bn: 'উপনয়ন (পৈতে)', hi: 'उपनयन', en: 'Upanayan (Sacred Thread)' },
    short: { bn: 'পৈতে ধারণের সম্পূর্ণ অনুষ্ঠান',
             en: 'Full sacred-thread ceremony' } },

  { slug: 'biye', durationMin: 360, slotSpan: 2, muhuratSensitive: true,
    bandMin: R(11000), bandMax: R(31000), bandDefault: R(15100),
    names: { bn: 'বিবাহ', hi: 'विवाह', en: 'Bengali Wedding' },
    short: { bn: 'সম্পূর্ণ বাঙালি বিবাহ অনুষ্ঠান (লগ্ন অনুযায়ী)',
             en: 'Complete Bengali wedding ceremony, timed to the lagna' } },

  { slug: 'sraddha', durationMin: 240, slotSpan: 2, muhuratSensitive: true,
    bandMin: R(3100), bandMax: R(8100), bandDefault: R(5100),
    names: { bn: 'শ্রাদ্ধ', hi: 'श्राद्ध', en: 'Sraddha' },
    short: { bn: 'পারলৌকিক ক্রিয়া ও শ্রাদ্ধানুষ্ঠান',
             en: 'Post-funerary rites' } },

  { slug: 'tarpan', durationMin: 60, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(501), bandMax: R(1500), bandDefault: R(801),
    names: { bn: 'তর্পণ', hi: 'तर्पण', en: 'Tarpan' },
    short: { bn: 'পিতৃপুরুষের উদ্দেশে জলদান',
             en: 'Water offering to ancestors' } },

  { slug: 'durga-puja-ghot', durationMin: 240, slotSpan: 2, muhuratSensitive: true,
    bandMin: R(8100), bandMax: R(25000), bandDefault: R(12100),
    names: { bn: 'দুর্গা পূজা (ঘট)', hi: 'दुर्गा पूजा', en: 'Durga Puja (Ghot, at home)' },
    short: { bn: 'বাড়িতে ঘট স্থাপন করে দুর্গা পূজা',
             en: 'Home Durga Puja with ghot installation' } },

  { slug: 'kali-puja', durationMin: 180, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(3100), bandMax: R(9100), bandDefault: R(5100),
    names: { bn: 'কালী পূজা', hi: 'काली पूजा', en: 'Kali Puja' },
    short: { bn: 'নিশীথে কালী পূজা ও হোম', en: 'Midnight Kali Puja with homa' } },

  { slug: 'lakshmi-puja', durationMin: 120, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1100), bandMax: R(3100), bandDefault: R(1800),
    names: { bn: 'লক্ষ্মী পূজা (কোজাগরী)', hi: 'लक्ष्मी पूजा', en: 'Lakshmi Puja (Kojagari)' },
    short: { bn: 'কোজাগরী পূর্ণিমায় লক্ষ্মী পূজা',
             en: 'Kojagari Purnima Lakshmi Puja' } },

  { slug: 'saraswati-puja', durationMin: 120, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1100), bandMax: R(3100), bandDefault: R(1600),
    names: { bn: 'সরস্বতী পূজা', hi: 'सरस्वती पूजा', en: 'Saraswati Puja' },
    short: { bn: 'বসন্ত পঞ্চমীতে সরস্বতী পূজা ও পুষ্পাঞ্জলি',
             en: 'Basant Panchami Saraswati Puja with pushpanjali' } },

  { slug: 'ganesh-puja', durationMin: 90, slotSpan: 1, muhuratSensitive: false,
    bandMin: R(901), bandMax: R(2500), bandDefault: R(1300),
    names: { bn: 'গণেশ পূজা', hi: 'गणेश पूजा', en: 'Ganesh Puja' },
    short: { bn: 'যেকোনো শুভ কাজের আগে গণেশ পূজা',
             en: 'Ganesh Puja before any auspicious undertaking' } },

  { slug: 'bastu-puja', durationMin: 180, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(2100), bandMax: R(6100), bandDefault: R(3100),
    names: { bn: 'বাস্তু পূজা', hi: 'वास्तु शांति', en: 'Bastu Puja' },
    short: { bn: 'বাস্তুদোষ শান্তির পূজা ও হোম',
             en: 'Vastu correction puja with homa' } },

  { slug: 'rudrabhishek', durationMin: 150, slotSpan: 1, muhuratSensitive: false,
    bandMin: R(1500), bandMax: R(4100), bandDefault: R(2100),
    names: { bn: 'রুদ্রাভিষেক', hi: 'रुद्राभिषेक', en: 'Rudrabhishek' },
    short: { bn: 'শিবলিঙ্গে পঞ্চামৃত অভিষেক', en: 'Panchamrit abhishek of the Shivalinga' } },

  { slug: 'nabagraha-shanti', durationMin: 180, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(2500), bandMax: R(7100), bandDefault: R(3600),
    names: { bn: 'নবগ্রহ শান্তি', hi: 'नवग्रह शांति', en: 'Nabagraha Shanti' },
    short: { bn: 'গ্রহদোষ শান্তির জন্য নবগ্রহ হোম',
             en: 'Nabagraha homa for planetary remediation' } },

  { slug: 'bipodtarini-puja', durationMin: 90, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(901), bandMax: R(2100), bandDefault: R(1200),
    names: { bn: 'বিপত্তারিণী পূজা', hi: 'विपत्तारिणी पूजा', en: 'Bipodtarini Puja' },
    short: { bn: 'বিপদ থেকে রক্ষার ব্রত ও পূজা',
             en: 'Vow and puja for protection from misfortune' } },

  { slug: 'mangal-chandi-puja', durationMin: 90, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(901), bandMax: R(2100), bandDefault: R(1200),
    names: { bn: 'মঙ্গলচণ্ডী পূজা', hi: 'मंगल चंडी पूजा', en: 'Mangal Chandi Puja' },
    short: { bn: 'সংসারের মঙ্গল কামনায় চণ্ডী পূজা',
             en: 'Chandi Puja for household wellbeing' } },

  { slug: 'annapurna-puja', durationMin: 120, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1500), bandMax: R(3600), bandDefault: R(2100),
    names: { bn: 'অন্নপূর্ণা পূজা', hi: 'अन्नपूर्णा पूजा', en: 'Annapurna Puja' },
    short: { bn: 'অন্নপূর্ণা দেবীর আরাধনা', en: 'Worship of Devi Annapurna' } },

  { slug: 'jagaddhatri-puja', durationMin: 180, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(3100), bandMax: R(9100), bandDefault: R(5100),
    names: { bn: 'জগদ্ধাত্রী পূজা', hi: 'जगद्धात्री पूजा', en: 'Jagaddhatri Puja' },
    short: { bn: 'কার্তিক শুক্লা নবমীতে জগদ্ধাত্রী পূজা',
             en: 'Jagaddhatri Puja on Kartik Shukla Navami' } },

  { slug: 'kartik-puja', durationMin: 120, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1100), bandMax: R(3100), bandDefault: R(1600),
    names: { bn: 'কার্তিক পূজা', hi: 'कार्तिक पूजा', en: 'Kartik Puja' },
    short: { bn: 'কার্তিক সংক্রান্তিতে কার্তিক ঠাকুরের পূজা',
             en: 'Kartik Puja on Kartik Sankranti' } },

  { slug: 'bishwakarma-puja', durationMin: 90, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1100), bandMax: R(3600), bandDefault: R(1800),
    names: { bn: 'বিশ্বকর্মা পূজা', hi: 'विश्वकर्मा पूजा', en: 'Bishwakarma Puja' },
    short: { bn: 'কারখানা, দোকান ও যন্ত্রপাতির পূজা',
             en: 'Puja for workshops, shops and machinery' } },

  { slug: 'janmashtami-puja', durationMin: 120, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1100), bandMax: R(3100), bandDefault: R(1600),
    names: { bn: 'জন্মাষ্টমী (গোপাল পূজা)', hi: 'जन्माष्टमी', en: 'Janmashtami (Gopal Puja)' },
    short: { bn: 'গোপালের জন্মতিথিতে পূজা ও ভোগ',
             en: 'Janmashtami puja with bhog' } },

  { slug: 'shiva-ratri-puja', durationMin: 150, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1100), bandMax: R(3100), bandDefault: R(1600),
    names: { bn: 'শিবরাত্রি পূজা', hi: 'शिवरात्रि पूजा', en: 'Shiva Ratri Puja' },
    short: { bn: 'চার প্রহরে শিবপূজা', en: 'Four-prahar Shiva worship' } },

  { slug: 'halkhata', durationMin: 60, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(701), bandMax: R(2100), bandDefault: R(1100),
    names: { bn: 'হালখাতা (নববর্ষ)', hi: 'हालखाता', en: 'Halkhata (Poila Boishakh)' },
    short: { bn: 'পয়লা বৈশাখে নতুন খাতার পূজা',
             en: 'New account-book puja on Poila Boishakh' } },

  { slug: 'namkaran', durationMin: 90, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(1100), bandMax: R(2500), bandDefault: R(1500),
    names: { bn: 'নামকরণ', hi: 'नामकरण', en: 'Namkaran' },
    short: { bn: 'শিশুর নামকরণ অনুষ্ঠান', en: 'Naming ceremony' } },

  /* ------------------------------------------------------------------ remote --
   * These three were hardcoded marketing cards on the home page with a Book Now
   * that led to a catalogue not containing them. They are now real, bookable and
   * priced.
   *
   * The fourth card, "Express Booking", is deliberately NOT here. It described a
   * lead time, not a service — every ritual can be booked at short notice, so
   * modelling it as a ritual would have created a row nobody could perform. It is
   * a filter on the booking flow instead.
   */

  { slug: 'online-aarti', durationMin: 45, slotSpan: 1, muhuratSensitive: false,
    bandMin: R(399), bandMax: R(899), bandDefault: R(499),
    deliveryMode: 'virtual',
    names: { bn: 'অনলাইন আরতি', hi: 'ऑनलाइन आरती', en: 'Online Aarti' },
    short: { bn: 'ভিডিওতে সরাসরি আরতি, যেখানেই থাকুন',
             en: 'Live aarti by video, joined from anywhere' } },

  { slug: 'virtual-consultation', durationMin: 60, slotSpan: 1, muhuratSensitive: false,
    bandMin: R(899), bandMax: R(2100), bandDefault: R(1100),
    deliveryMode: 'virtual',
    names: { bn: 'ভার্চুয়াল পরামর্শ', hi: 'वर्चुअल परामर्श', en: 'Virtual Consultation' },
    short: { bn: 'অভিজ্ঞ পুরোহিতের সঙ্গে ভিডিও কলে পরামর্শ',
             en: 'Video consultation with an experienced purohit' } },

  { slug: 'personalised-puja', durationMin: 150, slotSpan: 1, muhuratSensitive: true,
    bandMin: R(2100), bandMax: R(5100), bandDefault: R(3499),
    names: { bn: 'ব্যক্তিগত পূজা', hi: 'व्यक्तिगत पूजा', en: 'Personalised Puja' },
    short: { bn: 'জন্মকুণ্ডলী অনুসারে বিশেষভাবে নির্ধারিত পূজা',
             en: 'Puja shaped around your birth chart' } },
];

/**
 * Samagri, tiered by the scale of the ritual.
 *
 * Previously ONE 13-item list was attached to all 25 rituals, so the materials bill
 * was ~₹1,000 whatever you booked. That produced two nonsenses at once: a tarpan —
 * water, til and kusha grass on a ghat — was charged a kalash, 250g of ghee and a
 * garland, so its materials cost TWICE its dakshina; while a full Bengali biye got
 * the same ₹1,000 of samagri, which would not cover the chhadnatala.
 *
 * Four kits now. The tier is a property of the ritual, not a constant.
 *
 * Prices are Kolkata catalogue rates in paise and remain illustrative — validate
 * with the consulting purohit before seeding production. Perishables are flagged
 * because they can never be pre-packed; they are same-day local sourcing, always.
 */
export type SamagriTier = 'none' | 'minimal' | 'standard' | 'elaborate' | 'grand';

export interface BomItemSeed {
  qty: string; unit: string; grade?: string; price: number; perishable?: boolean;
  names: { bn: string; hi: string; en: string };
}

/** Just what the rite physically needs. Tarpan and Halkhata. ~₹180. */
const MINIMAL_KIT: BomItemSeed[] = [
  { qty: '100', unit: 'g', price: R(40), names: { bn: 'তিল', hi: 'तिल', en: 'Til (sesame)' } },
  { qty: '1', unit: 'bunch', price: R(25), perishable: true,
    names: { bn: 'কুশ ও দূর্বা', hi: 'कुश और दूर्वा', en: 'Kusha and durba grass' } },
  { qty: '1', unit: 'bunch', price: R(60), perishable: true,
    names: { bn: 'ফুল', hi: 'फूल', en: 'Flowers' } },
  { qty: '1', unit: 'set', price: R(55), names: { bn: 'সিঁদুর ও চন্দন', hi: 'सिंदूर और चंदन', en: 'Sindoor and chandan' } },
];

/** The everyday household puja. ~₹880. */
const STANDARD_KIT: BomItemSeed[] = [
  { qty: '1', unit: 'kg', price: R(65), names: { bn: 'আতপ চাল', hi: 'अक्षत', en: 'Atop rice' } },
  { qty: '250', unit: 'g', price: R(180), names: { bn: 'ঘি', hi: 'घी', en: 'Ghee' } },
  { qty: '1', unit: 'packet', price: R(40), names: { bn: 'ধূপকাঠি', hi: 'अगरबत्ती', en: 'Incense sticks' } },
  { qty: '100', unit: 'g', price: R(60), names: { bn: 'ধুনো', hi: 'धूप', en: 'Dhuno resin' } },
  { qty: '50', unit: 'g', price: R(35), names: { bn: 'সিঁদুর', hi: 'सिंदूर', en: 'Sindoor' } },
  { qty: '100', unit: 'g', price: R(45), names: { bn: 'চন্দন', hi: 'चंदन', en: 'Sandalwood paste' } },
  { qty: '1', unit: 'piece', price: R(55), names: { bn: 'নারকেল', hi: 'नारियल', en: 'Coconut' } },
  { qty: '5', unit: 'piece', price: R(25), names: { bn: 'সুপারি', hi: 'सुपारी', en: 'Betel nut' } },
  { qty: '10', unit: 'piece', price: R(20), perishable: true,
    names: { bn: 'পান পাতা', hi: 'पान का पत्ता', en: 'Betel leaf' } },
  { qty: '1', unit: 'bunch', price: R(80), perishable: true,
    names: { bn: 'ফুল ও মালা', hi: 'फूल और माला', en: 'Flowers and garland' } },
  { qty: '1', unit: 'bunch', price: R(30), perishable: true,
    names: { bn: 'আমপাতা', hi: 'आम के पत्ते', en: 'Mango leaves' } },
  { qty: '1', unit: 'bunch', price: R(25), perishable: true,
    names: { bn: 'দূর্বা ঘাস', hi: 'दूर्वा घास', en: 'Durba grass' } },
  { qty: '1', unit: 'set', price: R(120), names: { bn: 'ঘট ও কলস', hi: 'कलश', en: 'Ghot and kalash' } },
  { qty: '250', unit: 'g', price: R(70), names: { bn: 'বাতাসা', hi: 'बताशा', en: 'Batasha' } },
  { qty: '1', unit: 'set', price: R(150), perishable: true,
    names: { bn: 'ফল (৫ প্রকার)', hi: 'फल', en: 'Fruit, five kinds' } },
];

/** A homa, a longer vidhi, more guests. Griha prabesh, annaprashan, sraddha. ~₹2,240. */
const ELABORATE_KIT: BomItemSeed[] = [
  ...STANDARD_KIT,
  { qty: '500', unit: 'g', price: R(140), names: { bn: 'হোম সামগ্রী', hi: 'हवन सामग्री', en: 'Homa samagri' } },
  { qty: '500', unit: 'g', price: R(360), names: { bn: 'অতিরিক্ত ঘি', hi: 'अतिरिक्त घी', en: 'Additional ghee' } },
  { qty: '1', unit: 'set', price: R(140), perishable: true,
    names: { bn: 'পঞ্চামৃত', hi: 'पंचामृत', en: 'Panchamrit set' } },
  { qty: '1', unit: 'set', price: R(220), names: { bn: 'নতুন বস্ত্র', hi: 'नया वस्त्र', en: 'New cloth' } },
  { qty: '1', unit: 'set', price: R(200), perishable: true,
    names: { bn: 'অতিরিক্ত ফল ও মিষ্টি', hi: 'अतिरिक्त फल और मिठाई', en: 'Additional fruit and sweets' } },
];

/** Multi-day or multi-hour ceremonies. Biye, upanayan, a household Durga puja. ~₹8,380. */
const GRAND_KIT: BomItemSeed[] = [
  ...ELABORATE_KIT,
  { qty: '1', unit: 'set', price: R(900), names: { bn: 'বড় হোমকুণ্ড সামগ্রী', hi: 'हवन कुंड सामग्री', en: 'Large homa kund materials' } },
  { qty: '1', unit: 'set', price: R(1200), perishable: true,
    names: { bn: 'নবপত্রিকা ও ছাদনাতলা সামগ্রী', hi: 'नवपत्रिका सामग्री', en: 'Navapatrika and mandap materials' } },
  { qty: '1', unit: 'lot', price: R(1100), perishable: true,
    names: { bn: 'বিপুল ফুল ও মালা', hi: 'फूल और माला', en: 'Flowers and garlands, full ceremony' } },
  { qty: '2', unit: 'kg', price: R(720), names: { bn: 'ঘি (২ কেজি)', hi: 'घी', en: 'Ghee, two kilos' } },
  { qty: '1', unit: 'set', price: R(800), names: { bn: 'পূজার বাসনপত্র', hi: 'पूजा के बर्तन', en: 'Puja vessels' } },
  { qty: '1', unit: 'set', price: R(700), perishable: true,
    names: { bn: 'ভোগ ও মিষ্টি', hi: 'भोग और मिठाई', en: 'Bhog and sweets' } },
];

export const SAMAGRI_KITS: Record<SamagriTier, BomItemSeed[]> = {
  none: [],
  minimal: MINIMAL_KIT,
  standard: STANDARD_KIT,
  elaborate: ELABORATE_KIT,
  grand: GRAND_KIT,
};

/**
 * Which kit each ritual takes. Anything unlisted is `standard`, which is the right
 * default for a household puja — the two that must never fall through are the tiny
 * rites (they get overcharged) and the ceremonies (they get undersupplied).
 */
const SAMAGRI_TIER: Record<string, SamagriTier> = {
  // Barely any materials at all.
  tarpan: 'minimal',
  halkhata: 'minimal',

  // A homa, a longer vidhi, guests to feed.
  //
  // Annaprashan and namkaran are deliberately NOT here despite being occasions: both
  // are short home rites with no homa, and the elaborate kit pushed their materials
  // above their dakshina — the same inversion that made tarpan absurd.
  'griha-prabesh': 'elaborate',
  sraddha: 'elaborate',
  'nabagraha-shanti': 'elaborate',
  'bastu-puja': 'elaborate',
  'kali-puja': 'elaborate',
  'jagaddhatri-puja': 'elaborate',
  'personalised-puja': 'elaborate',

  // Ceremonies that run for hours or days.
  biye: 'grand',
  upanayan: 'grand',
  'durga-puja-ghot': 'grand',

  // Nothing to carry down a video call.
  'online-aarti': 'none',
  'virtual-consultation': 'none',
};

export const samagriTierFor = (slug: string, deliveryMode?: string): SamagriTier =>
  deliveryMode === 'virtual' ? 'none' : (SAMAGRI_TIER[slug] ?? 'standard');

export const samagriKitFor = (slug: string, deliveryMode?: string): BomItemSeed[] =>
  SAMAGRI_KITS[samagriTierFor(slug, deliveryMode)];

export const BOM_ADDITIONS: Record<string, BomItemSeed[]> = {
  'satyanarayan-puja': [
    { qty: '1', unit: 'set', price: R(180),
      names: { bn: 'সিন্নির উপকরণ', hi: 'सिन्नी सामग्री', en: 'Sinni ingredients' } },
  ],
  // Homa samagri and new cloth come with the elaborate kit; these are the two items
  // specific to entering a house.
  'griha-prabesh': [
    { qty: '1', unit: 'piece', price: R(260),
      names: { bn: 'বাস্তু যন্ত্র', hi: 'वास्तु यंत्र', en: 'Vastu yantra' } },
    { qty: '1', unit: 'bottle', price: R(60),
      names: { bn: 'গঙ্গাজল', hi: 'गंगाजल', en: 'Gangajal' } },
  ],
  'annaprashan': [
    { qty: '1', unit: 'set', price: R(260),
      names: { bn: 'রূপার থালা ও বাটি', hi: 'चांदी की थाली', en: 'Silver plate and bowl' } },
    { qty: '1', unit: 'set', price: R(190), perishable: true,
      names: { bn: 'পায়েস ও মিষ্টি', hi: 'खीर और मिठाई', en: 'Payesh and sweets' } },
  ],
  'upanayan': [
    { qty: '3', unit: 'piece', price: R(90), names: { bn: 'পৈতে', hi: 'जनेऊ', en: 'Sacred thread' } },
    { qty: '1', unit: 'set', price: R(340),
      names: { bn: 'কৌপীন ও উত্তরীয়', hi: 'कौपीन', en: 'Kaupin and uttariya' } },
  ],
  'biye': [
    { qty: '1', unit: 'set', price: R(450),
      names: { bn: 'সপ্তপদী ও যজ্ঞ সামগ্রী', hi: 'सप्तपदी सामग्री', en: 'Saptapadi and yajna items' } },
    { qty: '2', unit: 'piece', price: R(160), perishable: true,
      names: { bn: 'কলাগাছ', hi: 'केले का पेड़', en: 'Banana plants' } },
    { qty: '1', unit: 'set', price: R(240),
      names: { bn: 'টোপর ও মুকুট', hi: 'मुकुट', en: 'Topor and mukut' } },
  ],
  'sraddha': [
    { qty: '1', unit: 'set', price: R(210),
      names: { bn: 'পিণ্ড দানের উপকরণ', hi: 'पिंडदान सामग्री', en: 'Pind daan items' } },
    { qty: '250', unit: 'g', price: R(60), names: { bn: 'কালো তিল', hi: 'काला तिल', en: 'Black sesame' } },
  ],
  'tarpan': [
    { qty: '250', unit: 'g', price: R(60), names: { bn: 'কালো তিল', hi: 'काला तिल', en: 'Black sesame' } },
  ],
  'durga-puja-ghot': [
    { qty: '1', unit: 'kg', price: R(320), names: { bn: 'হোম সামগ্রী', hi: 'हवन सामग्री', en: 'Homa samagri' } },
    { qty: '108', unit: 'piece', price: R(210), perishable: true,
      names: { bn: 'পদ্ম ফুল', hi: 'कमल', en: 'Lotus flowers' } },
  ],
  'rudrabhishek': [
    { qty: '1', unit: 'set', price: R(230),
      names: { bn: 'পঞ্চামৃত', hi: 'पंचामृत', en: 'Panchamrit' } },
    { qty: '108', unit: 'piece', price: R(70), perishable: true,
      names: { bn: 'বেলপাতা', hi: 'बेलपत्र', en: 'Bel leaves' } },
  ],
  'nabagraha-shanti': [
    { qty: '1', unit: 'set', price: R(380),
      names: { bn: 'নবগ্রহ সমিধ ও রত্ন', hi: 'नवग्रह समिधा', en: 'Nabagraha samidha' } },
  ],
  'saraswati-puja': [
    { qty: '1', unit: 'set', price: R(120), perishable: true,
      names: { bn: 'পলাশ ফুল ও কুল', hi: 'पलाश और बेर', en: 'Palash flowers and kul' } },
  ],
  'bishwakarma-puja': [
    { qty: '1', unit: 'set', price: R(140),
      names: { bn: 'যন্ত্রপাতি পূজার উপকরণ', hi: 'यंत्र पूजा सामग्री', en: 'Tool-worship items' } },
  ],
  'halkhata': [
    { qty: '1', unit: 'piece', price: R(90),
      names: { bn: 'লাল খাতা', hi: 'लाल बही', en: 'Red ledger book' } },
  ],
};

export const KOLKATA_SLOT_DEFS = [
  { idx: 0, start: '06:00', end: '09:00' },
  { idx: 1, start: '09:30', end: '12:30' },
  { idx: 2, start: '13:00', end: '16:00' },
  { idx: 3, start: '16:30', end: '19:30' },
];
