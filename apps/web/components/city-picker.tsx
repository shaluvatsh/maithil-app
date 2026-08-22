'use client';
import { useMemo, useState } from 'react';
import { useRegion } from '@/lib/region-context';

/**
 * City picker. Every serviced city, searchable, grouped by state.
 *
 * Rendered in normal flow behind a fixed overlay rather than as a portal, so it works
 * without a modal library and cannot trap scroll.
 */
export function CityPicker({ onClose }: { onClose: () => void }) {
  const { regions, region, setCity } = useRegion();
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matched = regions.filter((r) =>
      !needle ||
      r.name.en.toLowerCase().includes(needle) ||
      r.name.native.includes(q.trim()) ||
      r.state.toLowerCase().includes(needle));
    const byState = new Map<string, typeof matched>();
    for (const r of matched) byState.set(r.state, [...(byState.get(r.state) ?? []), r]);
    return [...byState.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [regions, q]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '80px 20px',
      }}
    >
      <div className="card" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(680px, 100%)', maxHeight: '70vh', overflowY: 'auto', padding: 24 }}>
        <div className="spread" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: '1.25rem' }}>Select your city</h3>
          <button className="btn outline sm" onClick={onClose}>Close</button>
        </div>

        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
               placeholder="Search city or state…" style={{ width: '100%', marginBottom: 18 }} />

        {groups.length === 0 && (
          <p className="muted">
            We are not in that city yet. Tell us where you are and we will prioritise it.
          </p>
        )}

        {groups.map(([state, list]) => (
          <div key={state} style={{ marginBottom: 18 }}>
            <div className="faint" style={{
              fontSize: '.72rem', fontWeight: 700, letterSpacing: '.08em',
              textTransform: 'uppercase', marginBottom: 8,
            }}>{state}</div>
            <div className="row" style={{ gap: 8 }}>
              {list.map((r) => (
                <button key={r.slug}
                        className={r.slug === region.slug ? '' : 'outline'}
                        onClick={() => { setCity(r.slug); onClose(); }}
                        style={{ borderRadius: 999 }}>
                  {r.name.en}
                  <span style={{ opacity: .6, marginLeft: 8, fontWeight: 400 }}>{r.name.native}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
