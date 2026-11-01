'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useRegion } from '@/lib/region-context';
import { ensureScriptFonts } from '@/lib/community';
import { events, type EventDetail, type EventSession } from '@/lib/events';
import { auth } from '@/lib/api';
import { SEATS_MIN, SEATS_MAX } from '@themaithil/contracts';
import type { Translator } from '@themaithil/region';

/**
 * One event, and its days.
 *
 * A nine-day paath is nine sessions and each is separately attended, separately full
 * and separately given up — so every session carries its own state and its own
 * button. The page never offers an action the server would refuse: if the reader is
 * already on the waiting list it says so instead of showing "Reserve" again.
 */
export default function EventPage() {
  const { t, region, numerals, time, date: fmtDate, money } = useRegion();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  const [e, setE] = useState<EventDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => { setSignedIn(Boolean(auth.token)); }, []);

  const load = useCallback(async () => {
    try {
      const res = await events.detail(id);
      ensureScriptFonts(res.scripts);
      setE(res);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  }, [id]);

  useEffect(() => { if (id) void load(); }, [id, load]);

  if (err) return <main className="wrap ev-wrap"><p className="ev-error">{err}</p></main>;
  if (!e) return <main className="wrap ev-wrap"><p className="muted">{t('common.loading')}</p></main>;

  return (
    <main className="wrap ev-wrap ev-detail">
      <Link href="/events" className="btn-link ev-back">← {t('events.backToEvents')}</Link>

      {/*
        * A cancelled event stays readable, loudly. Somebody who reserved a place and
        * is standing outside a locked hall needs this page to tell them why.
        */}
      {e.state === 'cancelled' && <p className="ev-cancelled">{t('events.cancelled')}</p>}

      <h1 lang={e.locale}>{e.title}</h1>
      <p className="ev-where muted">
        {e.venueName} · {e.venueLine1} · {e.cityName ?? region.name.en}
      </p>
      <p className="ev-host muted">
        {e.hostVerified
          ? <>{t('events.hostedBy', { name: e.hostName })} <span className="ev-tick">✓</span></>
          : t('events.listedBy', { name: e.hostName })}
      </p>

      <p className="ev-desc" lang={e.locale}>{e.description}</p>

      {e.externalUrl && (
        // A listing that registers people elsewhere. Sent out deliberately rather
        // than pretending we can reserve a place we do not control.
        <p><a href={e.externalUrl} className="btn outline sm" rel="noreferrer noopener"
              target="_blank">{t('events.externalLink')}</a></p>
      )}

      <h2 className="ev-h">{t('events.sessions')}</h2>
      <ul className="ev-sessions">
        {e.sessions.map((s) => (
          <SessionRow
            key={s.id} s={s} mode={e.registrationMode}
            cancelledEvent={e.state === 'cancelled'}
            signedIn={signedIn} onChange={load}
            fmt={{ time, fmtDate, money, numerals, t }}
          />
        ))}
      </ul>
    </main>
  );
}

/** The formatters this row needs, passed down so the region context is read once. */
interface Fmt {
  time: (iso: string) => string;
  fmtDate: (iso: string) => string;
  money: (paise: number) => string;
  numerals: (v: string | number) => string;
  t: Translator;
}

function SessionRow({
  s, mode, cancelledEvent, signedIn, onChange, fmt,
}: {
  s: EventSession; mode: EventDetail['registrationMode'];
  cancelledEvent: boolean; signedIn: boolean;
  onChange: () => Promise<void>; fmt: Fmt;
}) {
  const { t, numerals, time, fmtDate, money } = fmt;
  const [seats, setSeats] = useState(SEATS_MIN);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const closed = cancelledEvent || Boolean(s.cancelledAt);
  const full = s.seatsLeft === 0;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(null);
    try { await fn(); await onChange(); }
    catch (x) { setMsg(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  };

  return (
    <li className={closed ? 'ev-session off' : 'ev-session'}>
      <div className="ev-session-when">
        <strong>{fmtDate(s.startAt.slice(0, 10))}</strong>
        <span className="muted">{time(s.startAt)} – {time(s.endAt)}</span>
        {s.pricePaise > 0 && <span className="ev-price">{money(s.pricePaise)}</span>}
        {closed && <span className="muted">{t('events.sessionCancelled')}</span>}
      </div>

      <div className="ev-session-act">
        {/*
          * Nothing to reserve: a listing is an invitation, not a booking. Offering a
          * button here would promise a seat that does not exist as a record.
          */}
        {mode === 'none' && <span className="muted">{t('events.justTurnUp')}</span>}

        {mode !== 'none' && s.yourState === 'confirmed' && (
          <>
            <span className="ev-in">{t('events.youreIn')}</span>
            <button
              type="button" className="btn ghost sm" disabled={busy || closed}
              onClick={() => void act(() => events.giveUp(s.id))}
            >
              {t('events.giveUp')}
            </button>
          </>
        )}

        {mode !== 'none' && s.yourState === 'waitlisted' && (
          <>
            {/* Said honestly. A waitlisted place is not a place. */}
            <span className="ev-waiting">{t('events.youreWaiting')}</span>
            <button
              type="button" className="btn ghost sm" disabled={busy || closed}
              onClick={() => void act(() => events.giveUp(s.id))}
            >
              {t('events.giveUp')}
            </button>
          </>
        )}

        {mode !== 'none' && !s.yourState && !closed && (
          signedIn ? (
            <>
              <label className="ev-seats">
                <span className="muted">{t('events.seats')}</span>
                <select
                  value={seats} onChange={(ev) => setSeats(Number(ev.target.value))}
                  disabled={busy}
                >
                  {/* Bounds from contracts, so the stepper and the clamp are one number. */}
                  {Array.from({ length: SEATS_MAX - SEATS_MIN + 1 }, (_, i) => SEATS_MIN + i)
                    .map((n) => <option key={n} value={n}>{numerals(n)}</option>)}
                </select>
              </label>
              <button
                type="button" className="btn sm" disabled={busy}
                onClick={() => void act(() => events.register(s.id, seats))}
              >
                {/* Full does not mean closed: it means the waiting list. */}
                {full ? t('events.full' as never) : t('events.reserve')}
              </button>
            </>
          ) : (
            <Link href={`/login?next=/events`} className="btn sm">
              {t('events.signInToReserve')}
            </Link>
          )
        )}
      </div>

      {msg && <p className="ev-msg">{msg}</p>}
    </li>
  );
}
