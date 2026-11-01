'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRegion } from '@/lib/region-context';
import { ensureScriptFonts } from '@/lib/community';
import { events, placeLabel, type EventCard } from '@/lib/events';
import { RADIUS_KM_MAX } from '@themaithil/contracts';

/**
 * Events near you.
 *
 * Soonest first, never newest first — an event list is a calendar, not a feed, and
 * nobody wants next month's aarti above tomorrow's. The cursor sorts on `start_at`
 * for exactly that reason.
 *
 * "Near me" asks the device for a location. If the reader declines, the city filter
 * still works, so the page degrades to something useful rather than to a permission
 * prompt with nothing behind it.
 */

/** Local midnight, so "in 2 days" means what the reader's own calendar says. */
function daysUntil(iso: string): number {
  const then = new Date(iso); then.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((then.getTime() - now.getTime()) / 86_400_000);
}

export default function EventsPage() {
  const { t, region, numerals, date: fmtDate, time } = useRegion();
  const [items, setItems] = useState<EventCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scope, setScope] = useState<'city' | 'near'>('city');
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (next?: string) => {
    setLoading(true); setErr(null);
    try {
      const res = await events.discover({
        ...(scope === 'near' && point
          // The bound comes from contracts, so the client cannot ask for a radius the
          // server would clamp anyway.
          ? { lat: point.lat, lng: point.lng, radiusKm: RADIUS_KM_MAX }
          : { citySlug: region.slug }),
        ...(next ? { cursor: next } : {}),
      });
      ensureScriptFonts(res.scripts);
      setItems((prev) => (next ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [scope, point, region.slug]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Asking for a location, and accepting no for an answer.
   *
   * On failure the scope stays on the city rather than leaving the reader on an
   * empty "near me" tab wondering what went wrong.
   */
  const locate = () => {
    if (!navigator.geolocation) { setScope('city'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setScope('near');
        setLocating(false);
      },
      () => { setScope('city'); setLocating(false); },
      { timeout: 8000 },
    );
  };

  return (
    <main className="wrap ev-wrap">
      <header className="ev-head">
        <h1>{t('events.title')}</h1>
        <p className="muted ev-blurb">{t('events.blurb')}</p>

        {/* Listing is the supply side of this surface: a purohit filling empty time
            with a group event is the one thing events do that bookings cannot. */}
        <p className="ev-hostlink">
          <Link href="/events/new" className="btn outline sm">{t('events.host')}</Link>
        </p>

        <div className="ev-scope" role="group">
          <button
            type="button" className={`chip${scope === 'city' ? ' on' : ''}`}
            onClick={() => setScope('city')}
          >
            {t('events.inCity', { city: region.name.en })}
          </button>
          <button
            type="button" className={`chip${scope === 'near' ? ' on' : ''}`}
            onClick={() => (point ? setScope('near') : locate())}
          >
            {locating ? t('events.locating') : t('events.near')}
          </button>
        </div>
      </header>

      {err && <p className="ev-error">{err}</p>}
      {!loading && !err && items.length === 0 && (
        <p className="muted ev-empty">{t('events.empty')}</p>
      )}

      <ul className="ev-list">
        {items.map((e) => {
          const away = daysUntil(e.startAt);
          return (
            <li key={e.id}>
              <Link href={`/events/${e.id}`} className="ev-card">
                <span className={`ev-when${away <= 1 ? ' soon' : ''}`}>
                  {away <= 0 ? t('events.today')
                    : away === 1 ? t('events.tomorrow')
                    : t('events.inDays', { count: numerals(away) })}
                  {' · '}{time(e.startAt)}
                </span>

                {/* Typeset in the language it was written in, like every other piece
                    of user content — a national list carries several scripts. */}
                <h2 className="ev-title" lang={e.locale}>{e.title}</h2>

                <p className="ev-where muted">
                  {placeLabel(e, region.name.en, numerals)}
                </p>

                <p className="ev-host muted">
                  {/*
                    * The liability tier, said in words.
                    *
                    * A listing is somebody else's event that we are carrying; a
                    * hosted one is ours. A reader deciding whether to travel across
                    * a city on a festival morning is entitled to know which.
                    */}
                  {e.hostVerified
                    ? t('events.hostedBy', { name: e.hostName })
                    : t('events.listedBy', { name: e.hostName })}
                </p>

                <p className="ev-seats">
                  {e.registrationMode === 'none'
                    ? <span className="muted">{t('events.justTurnUp')}</span>
                    : e.seatsLeft === null
                      ? <span className="muted">{t('events.seatsUnlimited')}</span>
                      : e.seatsLeft === 0
                        ? <span className="ev-full">{t('events.full')}</span>
                        : t('events.seatsLeft', { count: numerals(e.seatsLeft) })}
                  {' · '}<span className="muted">{fmtDate(e.startAt.slice(0, 10))}</span>
                </p>
              </Link>
            </li>
          );
        })}
      </ul>

      {loading && <p className="muted">{t('common.loading')}</p>}
      {cursor && !loading && (
        <button type="button" className="btn outline ev-more" onClick={() => void load(cursor)}>
          {t('events.loadMore')}
        </button>
      )}
    </main>
  );
}
