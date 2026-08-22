/**
 * The string catalogue.
 *
 * Typed as a const object so that `t('slot.morning')` is checked at compile time and
 * a missing key in a new locale is a build error, not a `{{slot.morning}}` shipped to
 * a devotee. English is the reference; every other locale is `Partial` and falls back.
 */
export const en = {
  'brand.tagline': 'Book a verified purohit',

  'nav.book': 'Book',
  'nav.panchang': 'Panchang',
  'nav.purohit': 'Purohit',
  'nav.admin': 'Admin',
  'nav.signOut': 'Sign out',

  'slot.brahma': 'Brahma muhurta',
  'slot.morning': 'Morning',
  'slot.forenoon': 'Late morning',
  'slot.afternoon': 'Afternoon',
  'slot.evening': 'Evening',

  'panjika.question': 'Which panjika does your family follow?',
  'panjika.why':
    'Households here keep more than one almanac, and they do not always agree. We use yours to decide which days we call auspicious.',
  'panjika.unsure': 'Not sure — show me all of them',
  'panjika.changeable':
    'You can change this any time. Bookings already made keep the panjika they were made with.',
  'panjika.disagree': 'The almanacs differ on this date',

  'panchang.tithi': 'Tithi',
  'panchang.nakshatra': 'Nakshatra',
  'panchang.best': 'Abhijit · best',
  'panchang.avoid': 'Rahu Kaal · avoid',
  'panchang.auspicious': 'Auspicious',
  'panchang.today': 'Today',

  'bill.dakshina': 'Dakshina',
  'bill.samagri': 'Samagri',
  'bill.travel': 'Travel',
  'bill.fee': 'Our fee',
  'bill.discount': 'Discount',
  'bill.total': 'Total',
  'bill.payNow': 'Pay online now',
  'bill.cashOnDay': 'Cash to purohit on the day',
  'bill.chargedOnCompletion': 'Charged on completion',
  'bill.surge': 'High-demand date',
  'bill.reassurance':
    'The cash amount is fixed now, so nothing is negotiated at your door.',

  'booking.pickRitual': 'Choose a ritual',
  'booking.pickDate': 'Pick a date',
  'booking.pickSlot': 'Pick a slot',
  'booking.pickPurohit': 'Available purohits',
  'booking.review': 'Review',
  'booking.confirm': 'Confirm',
  'booking.newPurohit': 'New',
  'booking.noReviews': 'No reviews yet',
  'booking.years': 'years',

  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.change': 'Change',
} as const;

export type MessageKey = keyof typeof en;
export type Dictionary = Partial<Record<MessageKey, string>>;
