'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { allRegions } from '@themaithil/region';

/**
 * Transcribing festival dates from a panjika.
 *
 * WHO USES THIS. A consulting purohit or an operator, with a physical almanac open
 * beside them, working through a list. That one fact decides the whole design:
 *
 *   The GAPS are the interface. A screen showing only the dates already entered
 *   cannot tell you what is left, which is the only thing that matters when you are
 *   seventeen festivals into a book. So every festival is a row, always, and the
 *   count of what remains is at the top.
 *
 *   One school at a time. `festival_dates` is school-scoped because a panjika's
 *   Vijaya Dashami is the same date wherever its households live — and because ADR
 *   0003's whole premise is that the almanacs disagree, so there is no sense in a
 *   screen that mixes them.
 *
 *   No save button per row. Every date commits on blur, because somebody doing this
 *   for an hour should not lose a page of work to a closed tab, and because "did
 *   that save?" is the question this kind of screen usually leaves you with.
 *
 * WHY THESE DATES ARE TYPED AND NOT COMPUTED. See `0027_festival_dates.sql`: a
 * festival is a lunar date, this system does not hold the lunar month, and deriving
 * one would invent a third opinion contradicting the almanac a household actually
 * keeps. Somebody reading a book is the correct implementation.
 */
interface Row {
  festivalId: string;
  en: string;
  blurb: string;
  days: number;
  regions: string[];
  /** Null until transcribed; the id of the stored row once it has been. */
  id: string | null;
  date: string | null;
  endsOn: string | null;
}

interface Worksheet {
  school: string;
  from: string;
  to: string;
  rows: Row[];
  remaining: number;
}

/** Schools, from region config rather than a list here. */
function schoolOptions() {
  const seen = new Map<string, { id: string; native: string; english: string }>();
  for (const r of allRegions()) {
    for (const p of r.panjikas) if (!seen.has(p.id)) seen.set(p.id, p);
  }
  return [...seen.values()];
}

export function FestivalWorksheet() {
  const schools = useMemo(schoolOptions, []);
  const [school, setSchool] = useState(schools[0]?.id ?? '');
  const [year, setYear] = useState(new Date().getFullYear());
  const [sheet, setSheet] = useState<Worksheet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!school) return;
    setErr(null);
    try {
      setSheet(await api<Worksheet>(
        `/v1/admin/panchang/festivals?school=${school}`
        + `&from=${year}-01-01&to=${year}-12-31`,
      ));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [school, year]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Commit one row.
   *
   * A changed date is a DELETE then an INSERT, because `festival_dates` is unique on
   * (school, festival, date) — an upsert keyed on the date cannot change the date.
   * Clearing the field removes the entry and leaves the gap, which is how somebody
   * undoes a misreading.
   */
  const save = async (row: Row, date: string, endsOn: string) => {
    const key = row.festivalId;
    setBusy(key); setErr(null);
    try {
      if (row.id && (row.date !== date || (row.endsOn ?? '') !== endsOn)) {
        await api(`/v1/admin/panchang/festivals/${row.id}`, { method: 'DELETE' });
      }
      if (date) {
        await api('/v1/admin/panchang/festivals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            school, festivalId: row.festivalId, date,
            ...(endsOn ? { endsOn } : {}),
          }),
        });
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!sheet) {
    return (
      <>
        {err && <div className="notice err">{err}</div>}
        <p className="muted">Loading the worksheet…</p>
      </>
    );
  }

  return (
    <>
      <p className="sub">
        Dates read out of a panjika, one almanac at a time. Nothing here is computed —
        the almanacs disagree about these dates and that disagreement is the product,
        so a date we calculated would contradict the book a household actually keeps.
      </p>

      <div className="row fw-controls">
        <label className="field">
          <span>Almanac</span>
          <select value={school} onChange={(e) => setSchool(e.target.value)}>
            {schools.map((s) => (
              <option key={s.id} value={s.id}>{s.native} — {s.english}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Year</span>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {/* This year and the next two: a panjika is published a year ahead, and
                nobody transcribes history. */}
            {[0, 1, 2].map((n) => {
              const y = new Date().getFullYear() + n;
              return <option key={y} value={y}>{y}</option>;
            })}
          </select>
        </label>

        {/* What is left, at the top. The reason the screen exists. */}
        <p className="fw-left">
          {sheet.remaining === 0
            ? <strong>All {sheet.rows.length} entered for {year}.</strong>
            : <><strong>{sheet.remaining}</strong> of {sheet.rows.length} still need a date.</>}
        </p>
      </div>

      {err && <div className="notice err">{err}</div>}

      <ul className="fw-rows">
        {sheet.rows.map((row) => (
          <li key={row.festivalId} className={row.date ? 'fw-row done' : 'fw-row'}>
            <div className="fw-name">
              <strong>{row.en}</strong>
              <span className="muted">{row.blurb}</span>
              <span className="muted fw-who">
                {row.regions.length === 0
                  ? 'everywhere we serve'
                  // So a transcriber can skip what this almanac's households do not keep.
                  : row.regions.join(', ')}
                {row.days > 1 && ` · ${row.days} days`}
              </span>
            </div>

            <DateCell row={row} busy={busy === row.festivalId} onSave={save} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * One row's dates, committed on blur.
 *
 * Local state so typing is not fighting a refetch, and `onBlur` rather than a button
 * so an hour of transcription cannot be lost to a closed tab. A multi-day festival
 * gets a second field; a single-day one does not, because an end date nobody needs is
 * a field somebody will fill in wrongly.
 */
function DateCell({
  row, busy, onSave,
}: {
  row: Row; busy: boolean;
  onSave: (row: Row, date: string, endsOn: string) => Promise<void>;
}) {
  const [date, setDate] = useState(row.date ?? '');
  const [endsOn, setEndsOn] = useState(row.endsOn ?? '');

  // Follow the server after a reload, so a correction elsewhere is reflected.
  useEffect(() => { setDate(row.date ?? ''); setEndsOn(row.endsOn ?? ''); },
    [row.date, row.endsOn]);

  const commit = () => {
    if (date === (row.date ?? '') && endsOn === (row.endsOn ?? '')) return;
    void onSave(row, date, endsOn);
  };

  return (
    <div className="fw-dates">
      <input
        type="date" value={date} disabled={busy}
        aria-label={`${row.en} start date`}
        onChange={(e) => setDate(e.target.value)}
        onBlur={commit}
      />
      {row.days > 1 && (
        <input
          type="date" value={endsOn} disabled={busy}
          aria-label={`${row.en} last day`}
          onChange={(e) => setEndsOn(e.target.value)}
          onBlur={commit}
        />
      )}
      {busy && <span className="muted">saving…</span>}
      {!busy && row.date && <span className="fw-tick" aria-label="recorded">✓</span>}
    </div>
  );
}
