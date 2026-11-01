'use client';
import { api } from '@/lib/api';
import type { EventCard, EventKind, EventRegistrationState } from '@themaithil/contracts';
import type { Script } from '@themaithil/region';

/**
 * The events client.
 *
 * Types come from `packages/contracts`, so the seat stepper's bounds and the API's
 * clamp are one number. The only thing added here is the query-string assembly and
 * the session shape, which the discovery card does not carry.
 */

export type { EventCard, EventKind };

export interface EventSession {
  id: string;
  startAt: string;
  endAt: string;
  capacity: number | null;
  seatsTaken: number;
  pricePaise: number;
  cancelledAt: string | null;
  /** Null when capacity is unlimited — see `seatsLeft` on the card. */
  seatsLeft: number | null;
  /** The viewer's own place, if they have one. */
  yourState: EventRegistrationState | null;
}

export interface EventDetail extends EventCard {
  /** The city's display name, so the page need not resolve the slug itself. */
  cityName: string;
  venueLine1: string;
  /**
   * Included because a CANCELLED event stays readable. Someone who reserved a place
   * and is standing outside a locked hall needs the page to say why.
   */
  state: 'published' | 'cancelled' | 'completed';
  externalUrl: string | null;
  sessions: EventSession[];
  scripts: Script[];
}

export interface Discovery {
  items: EventCard[];
  nextCursor: string | null;
  scripts: Script[];
}

const qs = (p: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const events = {
  discover: (p: {
    citySlug?: string; lat?: number; lng?: number; radiusKm?: number;
    kind?: EventKind; from?: string; locales?: string; cursor?: string; limit?: number;
  }) => api<Discovery>(`/v1/events${qs(p)}`, { auth: 'optional' }),

  detail: (id: string) => api<EventDetail>(`/v1/events/${id}`, { auth: 'optional' }),

  register: (sessionId: string, seats: number) =>
    api<{ id: string; state: EventRegistrationState; seats: number }>(
      `/v1/events/sessions/${sessionId}/registrations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seats }),
      },
    ),

  giveUp: (sessionId: string) =>
    api<{ cancelled: boolean; promoted: string | null }>(
      `/v1/events/sessions/${sessionId}/registrations`, { method: 'DELETE' },
    ),
};

/**
 * Where an event is, as honestly as we can say it.
 *
 * `distanceKm` is null when the venue's coordinate is a city centroid — every event
 * in the city shares that point, so a computed distance is exactly zero. Rendering
 * "0.0 km away" would be a number the reader acts on, so the city name is the
 * truthful answer instead.
 */
export const placeLabel = (
  e: Pick<EventCard, 'distanceKm' | 'citySlug' | 'venueName'>,
  cityName: string,
  numerals: (v: string | number) => string,
): string => (e.distanceKm === null
  ? `${e.venueName}, ${cityName}`
  : `${e.venueName} · ${numerals(e.distanceKm)} km`);
