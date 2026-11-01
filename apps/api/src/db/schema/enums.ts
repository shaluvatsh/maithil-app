import { pgEnum } from 'drizzle-orm/pg-core';

export const localeEnum = pgEnum('locale', ['bn', 'hi', 'en']);

/**
 * The panjika a household follows. First-class dimension - see ADR 0003.
 *
 * Not merely competing opinions. Mithila and Banaras keep the classical PURNIMANT
 * system, where a month ends at the full moon rather than the new moon. That shifts
 * which month a krishna-paksha tithi belongs to, and therefore shifts festival dates
 * and names - a structural difference, not a calibration one.
 *
 * This list held only the three Bengal-and-Mithila values while `packages/region`
 * had already been expanded pan-India, so twelve cities declared almanacs the
 * database could not store. The materialiser fell back to `bisuddha_siddhanta` for
 * all of them, which every city could store and no city outside Bengal offers, so
 * the rows were written and then never found. This list and
 * `packages/region/src/types.ts` must agree; `panjika-parity.test.ts` enforces it.
 */
export const panjikaSchoolEnum = pgEnum('panjika_school', [
  'bisuddha_siddhanta',
  'gupta_press',
  'mithila',
  'vikram_banaras',
  'tamil_vakya',
  'drik_generic',
]);

export const userRoleEnum = pgEnum('user_role', ['devotee', 'pandit', 'admin', 'ops']);
export const kycStatusEnum = pgEnum('kyc_status', [
  'pending', 'submitted', 'verified', 'rejected', 'expired',
  /**
   * Still under review, but we need something from the purohit.
   *
   * Distinct from `rejected`, which is a decision we have made. Most review outcomes
   * are not "no" — they are "send that one again", and collapsing the two meant a
   * reviewer who could not read one PAN card had to reject the whole application.
   */
  'changes_requested',
]);
export const kycTypeEnum = pgEnum('kyc_type', [
  'identity', 'bank', 'credential', 'demo', 'address', 'pan', 'qualification',
]);

/**
 * The highest qualification a purohit claims, proved by a `qualification` document.
 *
 * `pathshala` sits alongside the academic ladder rather than under it: a Veda
 * pathshala Shastri or Acharya may hold no board certificate at all, and a list that
 * forced them to answer "10th" would exclude exactly the people whose training
 * matters most here. Every option names a certificate that actually exists, because
 * a purohit must upload the one they select.
 */
export const qualificationLevelEnum = pgEnum('qualification_level', [
  '10th', '12th', 'diploma', 'graduate', 'post_graduate', 'doctorate', 'pathshala',
]);

export const bookingStateEnum = pgEnum('booking_state', [
  'draft', 'pending_accept', 'confirmed', 'in_progress', 'completed', 'reviewed',
  'cancelled_devotee', 'cancelled_pandit', 'expired',
]);
export const paymentModeEnum = pgEnum('payment_mode', [
  'digital_full', 'digital_token_balance', 'cash',
]);
export const samagriOptionEnum = pgEnum('samagri_option', ['none', 'pandit_brings']);
export const slotStatusEnum = pgEnum('slot_status', ['open', 'closed', 'booked', 'buffer']);
export const slotSourceEnum = pgEnum('slot_source', [
  'default', 'manual', 'recurring', 'travel_buffer', 'booking',
]);

export const panchangKindEnum = pgEnum('panchang_kind', [
  'tithi', 'nakshatra', 'yoga', 'karana',
]);
export const panchangSourceEnum = pgEnum('panchang_source', [
  'api', 'manual_panjika', 'pandit_override',
]);

export const ledgerDirectionEnum = pgEnum('ledger_direction', ['debit', 'credit']);
export const ledgerAccountTypeEnum = pgEnum('ledger_account_type', [
  'platform', 'pandit', 'devotee_credit', 'escrow', 'tax',
]);
export const ledgerEntryTypeEnum = pgEnum('ledger_entry_type', [
  'token', 'balance', 'commission', 'payout', 'refund',
  'credit_grant', 'credit_redeem',
  'cash_due', 'cash_recovery', 'cash_settled_direct',
  'tds', 'tds_carry', 'instant_payout_fee', 'adjustment',
  /*
   * Ticketed events. Declared with the rest of C2 so the enum and the tables ship
   * together, and unused until the money path is wired — `publishEvent` refuses a
   * ticketed event precisely so these cannot be reached half-built. ADR 0015.
   */
  'event_ticket', 'event_refund', 'event_commission',
]);

export const paymentIntentKindEnum = pgEnum('payment_intent_kind', [
  'token', 'balance', 'self_settle',
]);
export const paymentIntentStatusEnum = pgEnum('payment_intent_status', [
  'created', 'attempted', 'captured', 'failed', 'refunded',
]);
export const payoutMethodEnum = pgEnum('payout_method', ['bank_account', 'upi']);
export const payoutStatusEnum = pgEnum('payout_status', [
  'pending', 'processing', 'paid', 'failed', 'reversed',
]);
export const disputeTypeEnum = pgEnum('dispute_type', [
  'cash_mismatch', 'no_show', 'quality', 'refund', 'other',
]);
export const disputeStateEnum = pgEnum('dispute_state', [
  'open', 'awaiting_evidence', 'resolved', 'rejected',
]);

/**
 * How precise an address coordinate actually is.
 *
 * Travel time is derived from these coordinates (ADR 0013), and an estimate is
 * only as good as the point it starts from. A `city` coordinate is the city's
 * centroid — every address in Kolkata shares it, so the distance between two of
 * them is exactly zero and any buffer computed from it is meaningless. Recording
 * the provenance lets the scheduler widen its margin rather than trust a number
 * that was never measured.
 */
export const geoPrecisionEnum = pgEnum('geo_precision', ['exact', 'pincode', 'city']);

// ---------------------------------------------------------------------------
// Community. A separate bounded context (ADR 0014) — nothing in booking, ledger
// or payments may reference these, so the whole surface stays droppable.
// ---------------------------------------------------------------------------

/**
 * What a devotee may WRITE in, which is not what the app is TRANSLATED into.
 *
 * `locale` above holds three values because that is how many languages the product
 * interface exists in. Community content is authored by strangers, and a Chennai
 * household asking about a Vakya panchangam date will write Tamil whether or not we
 * have an interface for it. Storing that in a three-value enum means either losing
 * the question or mislabelling it as English.
 *
 * So: two enums, deliberately. `locale` is a UI capability and grows when we
 * translate the app; `content_locale` is the set of languages people speak in the
 * cities we serve, and it must equal `LANGUAGES` in `packages/region`. The parity is
 * enforced by `content-locale-parity.test.ts`, for the reason `panjika-parity`
 * exists: a drifting enum is invisible until it is a blank page in twelve cities.
 */
export const contentLocaleEnum = pgEnum('content_locale', [
  'bn', 'hi', 'en', 'mai', 'ta', 'te', 'kn', 'ml', 'gu', 'or', 'mr',
]);

/**
 * Who a piece of community content is for. Law 1 of the community skill.
 *
 * Never inferred from the author's city. A Durga Puja thread is essential in Kolkata
 * and noise in Chennai, and a feed query that forgets this predicate is a national
 * firehose that looks perfectly fine in Kolkata-only dev data. The scope/target
 * pairing is a CHECK constraint, not a service rule.
 */
export const communityScopeEnum = pgEnum('community_scope', ['city', 'state', 'national']);

export const communitySpaceKindEnum = pgEnum('community_space_kind', [
  'ritual', 'city', 'tradition', 'festival', 'general',
]);

/**
 * Who may write in a space. Structural moderation: the cheapest way to keep content
 * out of a space is to make it impossible to post there, not to review it afterwards.
 */
export const communityPostingPolicyEnum = pgEnum('community_posting_policy', [
  'open', 'verified_only', 'pandit_only',
]);

/** question -> answer -> reply, and no further. Enforced by `assert_post_shape`. */
export const communityPostKindEnum = pgEnum('community_post_kind', [
  'question', 'answer', 'reply',
]);

/**
 * `held` is not `removed`.
 *
 * Triage holds a post for a human to look at; removal is a decision someone made.
 * Collapsing them means an automated false positive silently deletes a grieving
 * devotee's question, which is worse than a slow queue — so nothing in this product
 * auto-deletes, it only auto-holds.
 */
export const communityPostStateEnum = pgEnum('community_post_state', [
  'published', 'held', 'removed',
]);

/**
 * One reaction, and it is a pranam.
 *
 * An enum of one rather than a boolean, so a second reaction is a migration instead
 * of a schema redesign — and so the absence of a downvote is recorded as a decision.
 * Downvotes in a religious forum become sectarian scorekeeping within a week, and
 * there is no version of that worth operating.
 */
export const communityReactionKindEnum = pgEnum('community_reaction_kind', ['pranam']);

/**
 * The trust ladder. Earned capability, not a moderation queue.
 *
 * A throwaway account can react and reply; asking needs an account that has existed
 * for a while; starting a discussion needs a completed booking or an operator's say-so.
 * This removes the cheapest spam at zero ongoing moderation cost, which matters more
 * than any classifier when the team is two people.
 */
export const communityTrustLevelEnum = pgEnum('community_trust_level', [
  'restricted', 'newcomer', 'member', 'contributor',
]);

/**
 * Report reasons, specific to this domain rather than a generic "inappropriate".
 *
 * A generic reason tells a reviewer nothing and cannot be routed. These are the
 * categories that actually arrive on a Hindu religious forum in India, and
 * `off_platform` is here because a marketplace forum's most common harm is not
 * abuse — it is a purohit and a devotee agreeing to transact elsewhere.
 */
export const communityReportReasonEnum = pgEnum('community_report_reason', [
  'sectarian', 'caste', 'communal', 'political', 'medical_claim',
  'occult_solicitation', 'off_platform', 'spam', 'personal_info', 'other',
]);

export const communityReportStateEnum = pgEnum('community_report_state', [
  'open', 'acknowledged', 'actioned', 'rejected',
]);

// ---------------------------------------------------------------------------
// Events (C2). Their own state machine, deliberately NOT bookingStateEnum — a
// booking is one devotee at one address with escrow and an OTP handshake; an event
// is many devotees at a public venue with none of those. ADR 0015.
// ---------------------------------------------------------------------------

export const eventHostKindEnum = pgEnum('event_host_kind', [
  'pandit', 'devotee', 'org', 'platform',
]);

export const eventKindEnum = pgEnum('event_kind', [
  'puja', 'kirtan', 'katha', 'paath', 'festival', 'class', 'yatra', 'seva',
]);

/**
 * How someone takes part, and — not incidentally — who is liable.
 *
 * This single column carries the two-tier model from ADR 0015. `none` and `rsvp` are
 * a LISTING: anyone may create one, we are an intermediary, and no money moves.
 * `ticketed` and `seva_slots` are HOSTED: verified hosts only, we take the money, we
 * are on the hook. A devotee-listed event can therefore never take payment, which
 * removes the fake-ticketed-puja fraud class structurally rather than by vigilance.
 */
export const eventRegistrationModeEnum = pgEnum('event_registration_mode', [
  'none', 'rsvp', 'ticketed', 'seva_slots',
]);

export const eventStateEnum = pgEnum('event_state', [
  'draft', 'pending_review', 'published', 'cancelled', 'completed',
]);

/**
 * A seat's life.
 *
 * `held` exists for the minutes between choosing a seat and paying for it, and is
 * swept by TTL rather than by a job — the same Redis pattern slot holds use.
 * `waitlisted` is not optional: free RSVP events no-show at 40-60%, and an event
 * that shows "full" and then runs half empty teaches hosts the platform does not
 * work.
 */
export const eventRegistrationStateEnum = pgEnum('event_registration_state', [
  'held', 'confirmed', 'waitlisted', 'cancelled', 'attended', 'no_show',
]);

// ---------------------------------------------------------------------------
// Knowledge library (C3). Curated, reviewed, cited content — structurally closer
// to `rituals` + `ritual_translations` than to a forum post, which is why it is
// not `community_posts` with a flag. ADR 0014.
// ---------------------------------------------------------------------------

/**
 * What a piece of knowledge IS.
 *
 * `mantra_audio` is first among equals and the reason this surface is worth
 * building. `chantingSampleUrl` already exists on a purohit profile because devotees
 * judge shuddha uchcharan and no competitor lets them hear it; the same insight
 * applied to teaching is a mantra with correct pronunciation, a transcript and a
 * meaning — worth more to this audience than ten articles, and reaching the
 * households who read their own script slowly but listen perfectly.
 */
export const knowledgeTypeEnum = pgEnum('knowledge_type', [
  'article', 'ritual_guide', 'mantra_audio', 'video', 'shloka', 'glossary',
]);

/**
 * Who it is for. Two values, because three would be a lie.
 *
 * A first-time devotee asking what happens at their child's annaprashan and a
 * purohit checking a vidhi variant are genuinely different readers. Any finer
 * grading is a taxonomy nobody maintains.
 */
export const knowledgeLevelEnum = pgEnum('knowledge_level', ['beginner', 'deep']);

/**
 * The editorial path. `in_review` is not `draft`.
 *
 * A draft is the author's; an item in review has been handed over and is waiting on
 * somebody. Collapsing them means a reviewer cannot tell what is finished from what
 * is abandoned, which is how a review queue becomes a graveyard.
 */
export const knowledgeStatusEnum = pgEnum('knowledge_status', [
  'draft', 'in_review', 'published', 'retired',
]);
