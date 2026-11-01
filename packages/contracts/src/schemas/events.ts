import { z } from 'zod';
import { Ulid } from '../ids.js';
import { PanjikaSchool } from '../enums.js';
import { ContentLocale, PAGE_SIZE_MIN, PAGE_SIZE_MAX } from './community.js';

/**
 * EVENTS — the shared truth. ADR 0015.
 *
 * Deliberately a separate file from `community.ts` even though events live in the
 * community context: a client that only renders a Q&A feed should not have to parse
 * the event model, and the two have no types in common beyond `ContentLocale`.
 */

export const EventKind = z.enum([
  'puja', 'kirtan', 'katha', 'paath', 'festival', 'class', 'yatra', 'seva',
]);
export type EventKind = z.infer<typeof EventKind>;

export const EventHostKind = z.enum(['pandit', 'devotee', 'org', 'platform']);

/**
 * How someone takes part — and therefore who is liable.
 *
 * `none` and `rsvp` are a LISTING: anyone may create one, we are an intermediary,
 * no money moves, and the UI must say "as listed by X, unverified".
 * `ticketed` and `seva_slots` are HOSTED: we take the money and we are on the hook.
 * The database enforces that a devotee-listed event can never be either.
 */
export const EventRegistrationMode = z.enum(['none', 'rsvp', 'ticketed', 'seva_slots']);
export type EventRegistrationMode = z.infer<typeof EventRegistrationMode>;

export const EventState = z.enum([
  'draft', 'pending_review', 'published', 'cancelled', 'completed',
]);

export const EventRegistrationState = z.enum([
  'held', 'confirmed', 'waitlisted', 'cancelled', 'attended', 'no_show',
]);
export type EventRegistrationState = z.infer<typeof EventRegistrationState>;

/** True where the platform takes money, and therefore where it is answerable. */
export const isHostedMode = (m: EventRegistrationMode): boolean =>
  m === 'ticketed' || m === 'seva_slots';

/**
 * How many seats one person may take at once.
 *
 * A household, not a coach party. Bounded because an unbounded field on a free event
 * is how one person empties a hall by accident, and the number has to be the same in
 * the stepper and in the constraint.
 */
export const SEATS_MIN = 1;
export const SEATS_MAX = 10;

/**
 * The widest radius a discovery request may ask for, in kilometres.
 *
 * A bound rather than a preference: the query is public and cached, and an unbounded
 * radius over a national table is a table scan anyone can trigger. The per-city
 * sensible DEFAULT is a different question and belongs in `packages/region` —
 * 5 km is a neighbourhood in Mumbai and the whole city in Varanasi.
 */
export const RADIUS_KM_MIN = 1;
export const RADIUS_KM_MAX = 50;

const IsoInstant = z.string().datetime({ offset: true });

export const SessionInput = z.object({
  startAt: IsoInstant,
  endAt: IsoInstant,
  /** Null or absent means unlimited — an open-air tarpan has no seat count. */
  capacity: z.number().int().positive().nullish(),
  pricePaise: z.number().int().nonnegative().default(0),
});

export const CreateEvent = z.object({
  kind: EventKind,
  title: z.string().trim().min(6).max(180),
  description: z.string().trim().min(20).max(4000),
  locale: ContentLocale,
  citySlug: z.string().min(1),
  venueName: z.string().trim().min(2).max(160),
  venueLine1: z.string().trim().min(3).max(240),
  /** Required for any coordinate claim finer than the city centroid. */
  pincode: z.string().regex(/^\d{6}$/).optional(),
  startAt: IsoInstant,
  endAt: IsoInstant,
  panjikaSchool: PanjikaSchool.optional(),
  registrationMode: EventRegistrationMode.default('none'),
  ritualSlug: z.string().min(1).optional(),
  externalUrl: z.string().url().optional(),
  /** Omitted means one session spanning the whole event. */
  sessions: z.array(SessionInput).max(31).optional(),
});
export type CreateEvent = z.infer<typeof CreateEvent>;

export const DiscoverEvents = z.object({
  citySlug: z.string().min(1).optional(),
  /** With a point, results are ordered by distance and trimmed to the radius. */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(RADIUS_KM_MIN).max(RADIUS_KM_MAX).optional(),
  kind: EventKind.optional(),
  /** Only events starting on or after this instant. Defaults to now. */
  from: IsoInstant.optional(),
  locales: z.array(ContentLocale).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX).optional(),
});
export type DiscoverEvents = z.infer<typeof DiscoverEvents>;

export const RegisterForSession = z.object({
  seats: z.number().int().min(SEATS_MIN).max(SEATS_MAX).default(1),
});

export const EventCard = z.object({
  id: Ulid,
  kind: EventKind,
  title: z.string(),
  description: z.string(),
  locale: ContentLocale,
  citySlug: z.string(),
  venueName: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  panjikaSchool: PanjikaSchool.nullable(),
  registrationMode: EventRegistrationMode,
  hostKind: EventHostKind,
  hostName: z.string(),
  /** A verified purohit host. A listing by anyone else is shown as unverified. */
  hostVerified: z.boolean(),
  /**
   * Null when the event's coordinate is a city centroid.
   *
   * Not zero and not omitted: every event in a city shares that point, so a distance
   * computed from it is exactly zero and a "0.0 km away" label is a lie the reader
   * would act on. Null means "we do not know where in the city this is".
   */
  distanceKm: z.number().nullable(),
  /** Across all of the event's sessions. Null where capacity is unlimited. */
  seatsLeft: z.number().int().nullable(),
  sessionCount: z.number().int(),
});
export type EventCard = z.infer<typeof EventCard>;

export const DiscoverEventsResponse = z.object({
  items: z.array(EventCard),
  nextCursor: z.string().nullable(),
  scripts: z.array(z.string()),
});

/**
 * The event cursor sorts on `start_at`, not `published_at`.
 *
 * A feed of questions is newest-first; a list of events is soonest-first. Reusing the
 * community cursor would sort events by when they were created, which is exactly
 * backwards — nobody wants next month's aarti above tomorrow's.
 */
export interface EventCursor { startAt: string; id: string }

const SEP = '|';

export const encodeEventCursor = (c: EventCursor): string =>
  Buffer.from(`${c.startAt}${SEP}${c.id}`, 'utf8').toString('base64url');

export const decodeEventCursor = (raw: string | undefined): EventCursor | null => {
  if (!raw) return null;
  try {
    const parts = Buffer.from(raw, 'base64url').toString('utf8').split(SEP);
    const startAt = parts[0]; const id = parts[1];
    if (!startAt || !id || parts.length !== 2) return null;
    if (!Ulid.safeParse(id).success) return null;
    if (Number.isNaN(Date.parse(startAt))) return null;
    return { startAt, id };
  } catch {
    return null;
  }
};
