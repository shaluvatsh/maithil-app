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

  /*
   * Community. Every string here is read by someone who may be in any of eleven
   * languages, so none of it is ever written inline in a component — the
   * redaction notice especially, which the API sends as a sentinel precisely so
   * the client can localise it.
   */
  'community.title': 'Ask a Purohit',
  'community.blurb':
    'Questions about rituals, answered by verified purohits. Your name here is the one you choose — never the name on your bookings.',
  'community.ask': 'Ask a question',
  'community.empty': 'No questions here yet. Yours can be the first.',
  'community.verified': 'Verified purohit',
  'community.verifiedAnswer': 'Verified answer',
  'community.agree': '{{count}} purohits agree',
  'community.agreeOne': '1 purohit agrees',
  'community.accepted': 'This answered the question',
  'community.answers': '{{count}} answers',
  'community.answersOne': '1 answer',
  'community.noAnswers': 'No answers yet',
  'community.pranam': 'Pranam',
  'community.reply': 'Reply',
  'community.answer': 'Answer',
  'community.report': 'Report',
  'community.reported': 'Reported — someone will look at this.',
  'community.book': 'Book this purohit',
  'community.accordingTo': 'According to {{school}}',
  'community.redacted': 'contact details removed',
  'community.redactedWhy':
    'We remove phone numbers and links. Booking through the app keeps the escrow, the start and finish codes, and the refund you would otherwise lose.',
  'community.years': '{{count}} years',
  'community.moreAnswers': 'Other answers',
  'community.chooseName': 'Choose the name you post under',
  'community.chooseNameWhy':
    'This is all anyone sees. Your real name and your bookings stay private.',
  'community.displayName': 'Display name',
  'community.save': 'Save',
  'community.titleLabel': 'Your question, in one line',
  'community.bodyLabel': 'The details',
  'community.languageLabel': 'Language you are writing in',
  'community.schoolLabel': 'Does this depend on a panjika?',
  'community.schoolNone': 'No — it is not about a date',
  'community.scopeLabel': 'Who is this for?',
  'community.scopeCity': 'My city',
  'community.scopeNational': 'Anywhere in India',
  'community.post': 'Post',
  'community.held':
    'Thank you. A reviewer will look at this before it appears — nothing has been deleted.',
  'community.trustNotYet':
    'Not yet, rather than not allowed: starting a thread unlocks once your account is a day old, or as soon as you have completed a booking. You can reply to anything right now.',
  'community.spaceClosed': 'Only verified purohits post in this space.',
  'community.signInToAsk': 'Sign in to ask',
  'community.backToFeed': 'All questions',
  'community.filterAll': 'Everywhere',
  'community.filterCity': 'In {{city}}',
  'community.loadMore': 'More questions',
  'community.guidelines': 'Guidelines and how to report',

  /*
   * The language offer, rendered in the language being OFFERED — not the one
   * currently on screen. That is the whole point: a banner asking "read this in
   * Bengali?" in English is asking the question in the language the reader is
   * struggling with. Each dictionary phrases it naturally rather than translating
   * a template, so no interpolation is needed and none of them reads like a string
   * that was filled in.
   */
  /*
   * The purohit dashboard.
   *
   * Every number on that screen is paired with a plain sentence, because "78%
   * acceptance" means nothing and "you turned down 3 of 14" means something. The
   * `attention.*` keys are the important half: the API returns codes precisely so a
   * purohit reading Bengali is not told why their income stopped in English.
   */
  'dash.today': 'Today',
  'dash.todayNone': 'Nothing booked today.',
  'dash.todayCount': '{{count}} puja today',
  'dash.upcoming': '{{count}} booked ahead',
  'dash.awaiting': '{{count}} waiting for your answer',
  'dash.answerNow': 'Answer now',

  'dash.money': 'Your money',
  'dash.payable': 'Lands in your account',
  'dash.gross': 'Earned',
  'dash.dues': 'Cash you are holding for us',
  'dash.tds': 'Tax withheld',
  'dash.cashHeadroom': 'Cash jobs available up to {{amount}}',

  'dash.work': 'Your work',
  'dash.completed': '{{count}} completed in the last {{days}} days',
  'dash.dropped': '{{count}} you dropped',

  'dash.allocation': 'Why you are getting work',
  'dash.offered': 'Offered to you',
  'dash.nearMiss': 'Went to someone else',
  'dash.declinedAway': 'You turned down',
  'dash.allocationEmpty':
    'Nothing has been allocated yet. Once it has, this shows what you were offered and what you narrowly missed.',
  'dash.allocationNote':
    'We never show you another purohit. These are your own numbers.',
  'dash.lastScored': 'Your last match',
  'dash.compRating': 'Rating',
  'dash.compDistance': 'Distance',
  'dash.compPrice': 'Your rate',
  'dash.compExperience': 'Experience',
  'dash.newBoost': 'New-purohit boost — {{count}} bookings left',

  'dash.demand': 'Where the work is',
  'dash.demandWindow': 'Bookings in your city over the last {{days}} days',
  'dash.demandEmpty': 'No bookings in your city yet to learn from.',
  'dash.youCover': 'you cover this',
  'dash.outsideRadius': '{{km}} km — outside your {{radius}} km radius',
  'dash.locationUnknown': 'distance not known',
  'dash.yoursOnly': '{{count}} of them yours',
  'dash.withheld': 'too few to show',
  'dash.withheldWhy':
    'We do not show a neighbourhood total that could identify a household. Your own work is always exact.',
  'dash.widenRadius': 'Widen your radius',
  'dash.uncoveredLead':
    '{{count}} busy areas are outside the distance you travel.',

  'dash.standing': 'Where you stand',
  'dash.rating': 'Your rating',
  'dash.noRating': 'No reviews yet',
  'dash.acceptance': 'You accept',
  'dash.cohortMedian': 'Half the purohits in your city are at {{value}}',
  'dash.cohortSmall':
    'Too few purohits here to compare without naming someone, so we do not.',

  /*
   * The ladder. Every rung has a NAME and a CRITERION, and the criterion is not
   * optional copy: a badge whose condition is unstated is a mystery to whoever has it
   * and an insult to whoever does not.
   */
  'dash.ladder': 'Your standing',
  'dash.ladderBlurb':
    'Each of these is worked out from what you have actually done, and each says what the next one needs.',
  'dash.rung.verified': 'Verified purohit',
  'dash.rungWhy.verified': 'Identity, PAN and your qualification, checked by us.',
  'dash.rung.photo': 'A photograph',
  'dash.rungWhy.photo':
    'Without one, devotees see the first letter of your name in a circle — and they did not choose you, so that letter is all they get.',
  'dash.rung.chanting_sample': 'A recording of your chanting',
  'dash.rungWhy.chanting_sample':
    'Thirty seconds. Families judge shuddha uchcharan, and no other app lets them hear it.',
  'dash.rung.payout_linked': 'A bank account',
  'dash.rungWhy.payout_linked': 'So what you earn can reach you.',
  'dash.rung.cash_enabled': 'Cash jobs',
  'dash.rungWhy.cash_enabled': 'Settle what you are holding to keep these coming.',
  'dash.rung.qualification': 'Your training on record',
  'dash.rungWhy.qualification':
    'A pathshala certificate counts as much as a degree here.',
  'dash.rung.ten_pujas': 'Ten pujas completed',
  'dash.rungWhy.ten_pujas': 'Enough work that your rating starts to mean something.',
  'dash.rung.well_rated': 'Well rated',
  'dash.rungWhy.well_rated':
    'Five reviews above four and a half. Fewer than five is not a record.',
  'dash.rung.samagri_accurate': 'Samagri as promised',
  'dash.rungWhy.samagri_accurate':
    'Rated separately from you, so a poor kit never counts against your own work.',
  'dash.rung.community_voice': 'A voice in the community',
  'dash.rungWhy.community_voice':
    'Three answers another purohit has endorsed. Posting is easy; being endorsed is not.',
  'dash.rungProgress': '{{have}} of {{need}}',
  'dash.rungDone': 'done',

  'dash.attention': 'Worth doing',
  'dash.attn.kyc_incomplete':
    'Your verification is not finished, so devotees cannot see you.',
  'dash.attn.payout_account_missing':
    'You have earnings and no bank account linked. Add one to be paid.',
  'dash.attn.cash_jobs_paused':
    'Cash jobs are switched off for your account. Settle what you are holding.',
  'dash.attn.cash_headroom_low':
    'You are close to your cash limit. Settle up to keep taking cash jobs.',
  'dash.attn.auto_accept_off':
    'Turn on auto-accept and stop watching your phone for requests.',
  'dash.attn.no_chanting_sample':
    'Record 30 seconds of chanting. Devotees choose on it, and nobody else offers it.',
  'dash.fix': 'Fix this',

  /*
   * Events. Copy that carries two distinctions the reader has to be able to make:
   * whether the platform stands behind this event or is merely carrying the listing,
   * and whether they have a place or are waiting for one.
   */
  'events.host': 'List an event',
  'events.hostBlurb':
    'Anyone can list something happening near them. Only verified purohits can take money for a place, so a listing is free to attend or handled by you at the venue.',
  'events.fKind': 'What kind of event?',
  'events.fTitle': 'What is it called?',
  'events.fDescription': 'What happens, and who it is for',
  'events.fVenueName': 'Where — the name of the place',
  'events.fVenueLine': 'Street address',
  'events.fPincode': 'Pincode',
  'events.fPincodeWhy':
    'Without it we can only say which city this is in, not how far away it is.',
  'events.fDate': 'Which day?',
  'events.fStart': 'Starts',
  'events.fEnd': 'Ends',
  'events.fTimeWhy': 'Times are {{city}} time, wherever you are when you type them.',
  'events.fLanguage': 'Language you are writing in',
  'events.fPanjika': 'Dated by which panjika?',
  'events.fPanjikaNone': 'Not a dated observance',
  'events.fMode': 'How do people take part?',
  'events.fModeNone': 'Open to all — no need to reserve',
  'events.fModeRsvp': 'Reserve a place, free',
  'events.fModeMoneyNote':
    'Selling places is not open yet. List it as free and take payment at the venue.',
  'events.fCapacity': 'How many places? Leave blank if there is room for everyone.',
  'events.fExternal': 'A page with more details (optional)',
  'events.publish': 'Publish it',
  'events.published': 'It is live.',
  'events.inReview': 'Sent for review. We check anything we stand behind before it goes live.',
  'events.hostSignIn': 'Sign in to list an event',
  'events.hostDevoteeNote':
    'Listed by you, and shown as unverified. That is not a judgement — we simply have not checked it.',

  /*
   * The knowledge library. `learn.reviewedBy` is the load-bearing string: an
   * unattributed claim of review is worth nothing, so the reviewer is named on every
   * item, and `learn.translated` exists because a reader served a fallback language
   * deserves to know that is what happened.
   */
  'learn.write': 'Write something',
  'learn.writeBlurb':
    'Anyone may write here. Nothing appears until another purohit or an operator has read it — that check is the reason this library is worth reading.',
  'learn.fType': 'What are you writing?',
  'learn.fLevel': 'Who is it for?',
  'learn.fSlug': 'The web address for it',
  'learn.fSlugWhy': 'Lowercase words with hyphens. This is a URL for ever, so choose once.',
  'learn.fLang': 'Which language are you writing in?',
  'learn.fHeading': 'Title',
  'learn.fSummary': 'One or two sentences — this is all a list shows',
  'learn.fBody': 'The explanation',
  'learn.fTranscript': 'What is being said, written out',
  'learn.fTranscriptWhy':
    'Required for a recording. Without it nobody can search it, read along, or use it if they cannot hear.',
  'learn.fRitual': 'Is this about one ritual?',
  'learn.fRitualNone': 'Not about a particular ritual',
  'learn.fMedia': 'The recording',
  'learn.fCitations': 'Where does it say so?',
  'learn.fCitationWork': 'Work',
  'learn.fCitationChapter': 'Chapter',
  'learn.fCitationVerse': 'Verse',
  'learn.addCitation': 'Add another source',
  'learn.citationsWhy':
    'Optional, and the thing that makes this different from every other app: a source lets a reader check rather than take your word.',
  'learn.saveDraft': 'Save as a draft',
  'learn.submit': 'Send for checking',
  'learn.savedDraft': 'Saved. Send it for checking when you are ready.',
  'learn.sentForReview':
    'Sent. Another purohit or an operator will read it before it appears.',
  'learn.uploading': 'Uploading…',
  'learn.signInToWrite': 'Sign in to write',

  'learn.queue': 'Waiting to be checked',
  'learn.queueBlurb':
    'Anything here is unpublished. You are reading it because you can judge whether it is right — staff cannot.',
  'learn.queueEmpty': 'Nothing waiting.',
  'learn.queueWaiting': 'waiting {{time}}',
  'learn.publishIt': 'Publish it',
  'learn.sendBack': 'Send it back',
  'learn.sendBackWhy': 'What needs changing? The author reads this.',
  'learn.notYours': 'You wrote this, so somebody else has to check it.',

  'learn.title': 'Learn',
  'learn.blurb':
    'Explanations of how rituals are performed, written by purohits and checked by another before they appear here.',
  'learn.empty': 'Nothing published yet.',
  'learn.all': 'Everything',
  'learn.guides': 'Ritual guides',
  'learn.audio': 'Mantras to listen to',
  'learn.articles': 'Articles',
  'learn.beginner': 'For a first time',
  'learn.deep': 'In depth',
  'learn.by': 'By {{name}}',
  'learn.reviewedBy': 'Checked by {{name}}',
  'learn.unreviewed': 'Not yet checked',
  'learn.translated': 'Translated from {{locale}} — not the author’s own words',
  'learn.readIn': 'Also in',
  'learn.minutes': '{{count}} min',
  'learn.transcript': 'What is being said',
  'learn.sources': 'Where it says so',
  'learn.sourceLine': '{{work}} {{ref}}',
  'learn.citationsNone': 'No sources given for this one.',
  'learn.loadMore': 'More',
  'learn.backToLearn': 'All of Learn',
  'learn.onRitual': 'Before you book {{ritual}}',
  'learn.readGuide': 'Read this first',

  'events.title': 'Events near you',
  'events.blurb':
    'Pujas, kirtans and paaths happening nearby. Reserve a place, or simply turn up.',
  'events.empty': 'Nothing listed near you yet.',
  'events.near': 'Near me',
  'events.inCity': 'In {{city}}',
  'events.allKinds': 'Everything',
  'events.loadMore': 'More events',
  'events.today': 'Today',
  'events.tomorrow': 'Tomorrow',
  'events.inDays': 'in {{count}} days',
  'events.hostedBy': 'Hosted by {{name}}',
  'events.listedBy': 'Listed by {{name}} — we have not verified this event',
  'events.verifiedHost': 'Verified purohit',
  'events.justTurnUp': 'Open to all — just turn up',
  'events.seatsLeft': '{{count}} places left',
  'events.seatsUnlimited': 'Room for everyone',
  'events.full': 'Full — you can join the waiting list',
  'events.reserve': 'Reserve a place',
  'events.reserveSeats': 'Reserve {{count}} places',
  'events.seats': 'How many of you?',
  'events.youreIn': 'Your place is reserved',
  'events.youreWaiting': 'You are on the waiting list — we will tell you if a place opens',
  'events.giveUp': 'Give up my place',
  'events.gaveUp': 'Your place has been given up',
  'events.signInToReserve': 'Sign in to reserve',
  'events.externalLink': 'Details from the organiser',
  'events.sessions': 'Days and times',
  'events.cancelled': 'This was cancelled',
  'events.sessionCancelled': 'cancelled',
  'events.backToEvents': 'All events',
  'events.locating': 'Finding where you are…',

  'community.upcoming': 'Coming up',
  'community.today': 'Today',
  'community.tomorrow': 'Tomorrow',
  'community.inDays': 'in {{count}} days',
  'community.bookFor': 'Book a purohit for {{festival}}',

  'language.readIn': 'Read this in English',
  'language.notNow': 'No, thanks',
  'language.label': 'Language',

  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.change': 'Change',
} as const;

export type MessageKey = keyof typeof en;
export type Dictionary = Partial<Record<MessageKey, string>>;
