'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, auth } from '@/lib/api';
import { useRegion } from '@/lib/region-context';

/**
 * Services & rates, on their own page.
 *
 * These were two of the five steps stacked on `/purohit/setup` — a 32-item service
 * picker followed immediately by a per-service price input for everything chosen —
 * which on its own was most of what made that page "too long." They move here as
 * ONE combined, collapsible section rather than two separate screens: a purohit
 * editing an existing catalogue is adjusting "what I offer and for how much"
 * together, which is a different task from the wizard's first-run "pick, then
 * price" sequence.
 *
 * SELF-CONTAINED rather than sharing the wizard's internal state, and that is a
 * deliberate trade. `PurohitSetup` holds this exact data (catalogue/chosen/prices)
 * tightly coupled to its own stepper and five other fields; extracting a shared
 * component across a working, already-verified wizard and a differently-shaped edit
 * view risked more than it saved. The duplication here is about 70 lines of
 * fetch-and-render, not business logic — both read `GET /me/purohit/profile` and
 * write `PUT /me/purohit/services`, so there is exactly one place either could drift
 * from the server, and the server is what both are checked against in tests.
 */
interface CatalogueRow {
  id: string; slug: string; bandMin: number; bandMax: number; bandDefault: number;
}

const title = (slug: string) =>
  slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export default function PurohitRatesPage() {
  const router = useRouter();
  const { money } = useRegion();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(false);

  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [prices, setPrices] = useState<Record<string, number>>({});
  /** What was last saved, so Cancel can restore it and the summary never drifts
      from reality while the form is open and being edited. */
  const [clean, setClean] = useState<{ chosen: Set<string>; prices: Record<string, number> } | null>(null);

  useEffect(() => {
    if (!auth.token) { router.replace('/login?next=/purohit/rates'); return; }
    api<{
      services: Array<{ ritualId: string; pricePaise: number; active: boolean }>;
      catalogue: CatalogueRow[];
    }>('/v1/me/purohit/profile')
      .then((r) => {
        setCatalogue(r.catalogue);
        const active = r.services.filter((s) => s.active);
        const chosenSet = new Set(active.map((s) => s.ritualId));
        const priceMap = Object.fromEntries([
          ...r.catalogue.map((c) => [c.id, c.bandDefault]),
          ...active.map((s) => [s.ritualId, s.pricePaise]),
        ]);
        setChosen(chosenSet);
        setPrices(priceMap);
        setClean({ chosen: chosenSet, prices: priceMap });
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
    // Mount-once: `useRouter()` is a fresh object every render (see
    // `next/navigation`'s own typing and the test mock in `__tests__/setup.tsx`),
    // so depending on `router` here re-fires this fetch on every render forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flip = (id: string) => {
    const next = new Set(chosen);
    next.has(id) ? next.delete(id) : next.add(id);
    setChosen(next);
  };

  const picked = useMemo(
    () => catalogue.filter((c) => chosen.has(c.id)),
    [catalogue, chosen],
  );
  const outOfBand = (c: CatalogueRow) => {
    const p = prices[c.id] ?? c.bandDefault;
    return p < c.bandMin || p > c.bandMax;
  };

  const isDirty = clean !== null && (
    clean.chosen.size !== chosen.size
    || [...chosen].some((id) => !clean.chosen.has(id))
    || picked.some((c) => (clean.prices[c.id] ?? c.bandDefault) !== (prices[c.id] ?? c.bandDefault))
  );

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await api('/v1/me/purohit/services', {
        method: 'PUT',
        body: JSON.stringify({
          services: [...chosen].map((id) => ({ ritualId: id, pricePaise: prices[id] ?? 0 })),
        }),
      });
      setClean({ chosen: new Set(chosen), prices: { ...prices } });
      setSaved(true);
      // The save that makes the summary true is also the save that stops needing
      // the form open to show it — same rule as My Practice.
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (clean) { setChosen(new Set(clean.chosen)); setPrices({ ...clean.prices }); }
    setOpen(false);
  };

  if (loading) return <div className="wrap" style={{ padding: '40px 20px' }}><p className="muted">Loading…</p></div>;

  return (
    <div className="wrap" style={{ padding: '40px 20px 80px', maxWidth: 720 }}>
      <Link href="/purohit" className="btn-link" style={{ display: 'inline-block', marginBottom: 14 }}>
        ← My jobs
      </Link>
      <h1>Services &amp; rates</h1>
      <p className="sub">What you perform, and what you charge for it.</p>

      {err && <div className="notice err">{err}</div>}

      {!open && (
        <div className="practice-summary card">
          <p className="practice-sum-line">
            {picked.length === 0
              ? 'Nothing selected yet.'
              : `${picked.length} service${picked.length === 1 ? '' : 's'} · `
                + `${money(Math.min(...picked.map((c) => prices[c.id] ?? c.bandDefault)))}`
                + ` – ${money(Math.max(...picked.map((c) => prices[c.id] ?? c.bandDefault)))}`}
          </p>
          <button className="btn outline sm" onClick={() => setOpen(true)}>Edit</button>
        </div>
      )}

      {open && (
        <>
          <div className="spread" style={{ margin: '18px 0 14px' }}>
            <span className="muted">{chosen.size} of {catalogue.length} selected</span>
            <button className="linkish"
                    onClick={() => setChosen(chosen.size === catalogue.length
                      ? new Set() : new Set(catalogue.map((c) => c.id)))}>
              {chosen.size === catalogue.length ? 'Clear all' : 'Select all'}
            </button>
          </div>

          <div className="pickgrid two">
            {catalogue.map((c) => (
              <button key={c.id} type="button"
                      className={`opt${chosen.has(c.id) ? ' on' : ''}`}
                      aria-pressed={chosen.has(c.id)}
                      onClick={() => flip(c.id)}>
                <span className="t">{title(c.slug)}</span>
                <span className="s">{money(c.bandMin)} – {money(c.bandMax)}</span>
              </button>
            ))}
          </div>

          <h2 className="panel-h" style={{ marginTop: 28 }}>Your rates</h2>
          <p className="sub">
            This is your dakshina, and the devotee sees it. Keep it inside the range
            shown for each service — we do not let them be charged more than we
            advertised. If a range is wrong for your work, tell us and we will look
            at it.
          </p>

          <div className="ratelist">
            {picked.map((c) => {
              const bad = outOfBand(c);
              return (
                <div className={`rate${bad ? ' bad' : ''}`} key={c.id}>
                  <div>
                    <div className="nm">{title(c.slug)}</div>
                    <div className="rg">{money(c.bandMin)} – {money(c.bandMax)}</div>
                  </div>
                  <div className="amt">
                    <span aria-hidden="true">₹</span>
                    <input type="number" inputMode="numeric"
                           aria-label={`Your dakshina for ${title(c.slug)}`}
                           aria-invalid={bad || undefined}
                           aria-describedby={bad ? `rate-err-${c.id}` : undefined}
                           value={Math.round((prices[c.id] ?? c.bandDefault) / 100)}
                           onChange={(e) => setPrices({
                             ...prices, [c.id]: Math.round(Number(e.target.value) * 100),
                           })} />
                  </div>
                  {bad && (
                    <p className="rate-err" id={`rate-err-${c.id}`} role="alert">
                      Choose an amount between {money(c.bandMin)} and {money(c.bandMax)}.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="panel-save">
            <button className="btn" disabled={busy || !isDirty || picked.some(outOfBand)}
                    onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn ghost sm" disabled={busy} onClick={cancel}>Cancel</button>
            {isDirty
              ? <span className="panel-dirty">Not saved yet</span>
              : saved && <span className="panel-saved">Saved ✓</span>}
          </div>
        </>
      )}
    </div>
  );
}
