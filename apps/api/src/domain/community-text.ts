import { REDACTION_TOKEN } from '@themaithil/contracts';

/**
 * Contact scrubbing — pure, so it can be tested without a database.
 *
 * WHY THIS EXISTS. A community surface introduces devotees to purohits for free.
 * That is the feature and it is also the leak: the pair agree to meet off-platform,
 * the platform loses the booking, and the devotee loses every protection the booking
 * carried — the escrow, the OTP handshake at start and completion, the refund tiers,
 * the dispute path. The devotee is the one who ends up worse off, which is why this
 * is a safety control and not only a commercial one.
 *
 * WHAT IT IS NOT. It is not a filter that decides whether someone may post; the raw
 * text is always kept in `community_post_revisions` and a reviewer can read it. It
 * strips the digits and leaves the sentence, so "call me on 98300 12345" still reads
 * as an offer to talk and a moderator can see the intent.
 *
 * DELIBERATELY BLUNT about what it will not catch: "nine eight three zero zero",
 * a number inside an image, a Telegram handle spelled sideways. Chasing those is an
 * arms race that a two-person team loses. The flag this returns feeds a metric, and
 * the metric is what tells you whether the arms race has started.
 */

/**
 * An Indian mobile number, with the separators people actually type.
 *
 * Ten digits opening 6-9, optionally prefixed +91 / 91 / 0, and tolerating spaces,
 * dots and dashes anywhere between the digits. The leading-digit rule is what keeps
 * it from eating a year or a rupee amount.
 */
const PHONE = /(?:\+?91[\s.-]?|\b0)?[6-9](?:[\s.-]?\d){9}\b/g;

/** Any bare run of ten or more digits — a number typed without a country code. */
const LONG_DIGITS = /\b\d{10,}\b/g;

/** Email, and the UPI VPA that looks almost exactly like one. */
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g;
/** `name@paytm`, `9830012345@ybl` — a VPA has no dot in its handle. */
const UPI_VPA = /\b[\w.-]{2,}@(?:ok[a-z]+|[a-z]{3,})\b/g;

/** Links. A profile URL elsewhere is the same leak by another route. */
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Telegram and WhatsApp handles. `@name` only when it is not already an email or a
 * VPA, which the ordering below guarantees by running those first.
 */
const HANDLE = /(?:\bt\.me\/|\bwa\.me\/|(?<=\s|^)@)[\w.]{3,}/gi;

const PATTERNS = [EMAIL, UPI_VPA, URL, HANDLE, PHONE, LONG_DIGITS] as const;

export interface ScrubResult {
  /** Safe to render. Contact details replaced with the sentinel. */
  text: string;
  /**
   * True when anything was replaced.
   *
   * Feeds the disintermediation metric, which is the number that tells you whether
   * the leak is growing — and a post with this set is worth a moderator's glance
   * even though it was published, because intent is not the same as a rule break.
   */
  redacted: boolean;
}

export function scrubContact(raw: string): ScrubResult {
  let text = raw;
  for (const pattern of PATTERNS) {
    // `lastIndex` is shared state on a global regex; resetting it keeps repeated
    // calls from starting mid-string and silently missing the first match.
    pattern.lastIndex = 0;
    text = text.replace(pattern, REDACTION_TOKEN);
  }
  // Two adjacent redactions read as noise; one says the same thing.
  const collapsed = text.replace(
    new RegExp(`(?:${escapeRe(REDACTION_TOKEN)}[\\s.-]*){2,}`, 'g'),
    `${REDACTION_TOKEN} `,
  ).trim();
  return { text: collapsed, redacted: collapsed.includes(REDACTION_TOKEN) };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalise a body for lexicon matching.
 *
 * Lowercased, punctuation-stripped, whitespace-collapsed. Deliberately NOT
 * transliterated or stemmed: there is no stemmer for most of these languages, and a
 * wrong one would match things it should not. The lexicon is matched as substrings
 * against this, and `moderation_terms` is expected to carry both the native-script
 * and the Latin-script spelling of anything that matters, because that is how people
 * actually type.
 */
export const normaliseForMatching = (raw: string): string =>
  raw.toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
