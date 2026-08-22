'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { SlotTime } from '@/components/panchang/role-views';

/**
 * The usual working week.
 *
 * Availability is stored per (date, slot), which is right for booking — a lock has
 * to land on a specific afternoon. It is a terrible way to *declare* availability.
 * "I work Tuesday and Thursday mornings" is one sentence, and saying it through the
 * per-date calendar meant tapping four slots across thirty days: 120 decisions to
 * express one.
 *
 * This is the shift-booking shape every gig platform converged on, and for the same
 * reason: the worker states a repeating shape once, the system projects it forward,
 * and individual days are overridden by exception on the calendar.
 *
 * The exception genuinely wins. Saving a pattern only touches the slots the pattern
 * speaks about, and never touches a booked one — a purohit who closed next Tuesday
 * by hand and then edits their Thursday shift must not find Tuesday reopened.
 */
const WEEKDAYS = [
  { idx: 1, short: 'Mon' }, { idx: 2, short: 'Tue' }, { idx: 3, short: 'Wed' },
  { idx: 4, short: 'Thu' }, { idx: 5, short: 'Fri' }, { idx: 6, short: 'Sat' },
  { idx: 0, short: 'Sun' },
] as const;

export interface PatternCell { weekday: number; slotIdx: number }

/** `09:30:00` from Postgres, `9:30 am` for a human. */
const hhmm = (t: string) => {
  const [h = '0', m = '00'] = t.split(':');
  const n = Number(h);
  const twelve = n % 12 === 0 ? 12 : n % 12;
  return `${twelve}:${m} ${n >= 12 ? 'pm' : 'am'}`;
};

export function WeeklyPatternEditor({ slotTimes }: { slotTimes: SlotTime[] }) {
  const [cells, setCells] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ opened: number; closed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api<PatternCell[]>('/v1/me/purohit/weekly-pattern')
      .then((p) => setCells(new Set(p.map((c) => `${c.weekday}:${c.slotIdx}`))))
      .catch(() => setCells(new Set()))
      .finally(() => setLoaded(true));
  }, []);

  const toggle = (weekday: number, slotIdx: number) => {
    const key = `${weekday}:${slotIdx}`;
    setCells((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setDirty(true);
    setResult(null);
  };

  const save = async () => {
    setSaving(true); setError(null); setResult(null);
    try {
      const pattern = [...cells].map((k) => {
        const [w, s] = k.split(':');
        return { weekday: Number(w), slotIdx: Number(s) };
      });
      setResult(await api<{ opened: number; closed: number }>(
        '/v1/me/purohit/weekly-pattern',
        { method: 'PUT', body: JSON.stringify({ pattern }) },
      ));
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded || slotTimes.length === 0) return null;

  return (
    <section className="wk" aria-labelledby="wk-h">
      <div className="wk-head">
        <div>
          <h2 id="wk-h">My usual week</h2>
          <p className="muted">
            Tick the times you normally work. We&apos;ll keep your calendar filled in
            from this — you can still close a single day on the calendar below.
          </p>
        </div>
        <button className="btn" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? 'Saving…' : dirty ? 'Save my week' : 'Saved'}
        </button>
      </div>

      <div className="wk-grid" style={{ ['--slots' as string]: slotTimes.length }}>
        <span className="wk-corner" aria-hidden />
        {slotTimes.map((t) => (
          <span key={t.idx} className="wk-slot-head">
            {hhmm(t.startTime)}
            <small>{hhmm(t.endTime)}</small>
          </span>
        ))}

        {WEEKDAYS.map((d) => (
          <div key={d.idx} className="wk-row">
            <span className="wk-day">{d.short}</span>
            {slotTimes.map((t) => {
              const on = cells.has(`${d.idx}:${t.idx}`);
              return (
                <button
                  key={t.idx}
                  type="button"
                  className={on ? 'wk-cell on' : 'wk-cell'}
                  aria-pressed={on}
                  aria-label={`${d.short}, ${hhmm(t.startTime)} to ${hhmm(t.endTime)}`}
                  onClick={() => toggle(d.idx, t.idx)}
                >
                  {on ? '✓' : ''}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/*
        Reports what actually moved, not what was asked for. Booked slots are
        refused by the server, so a purohit who ticks a Saturday they are already
        working sees a number smaller than the ticks they made — and that is the
        honest report, not a rounding error.
      */}
      {result && (
        <p className="wk-result">
          Calendar updated — <strong>{result.opened}</strong> slots opened,{' '}
          <strong>{result.closed}</strong> closed. Any slot already booked was left
          alone.
        </p>
      )}
      {error && <p className="notice err">{error}</p>}
    </section>
  );
}
