'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useRegion } from '@/lib/region-context';
import type { PanjikaId } from '@themaithil/region';

/**
 * Asked once, before the first booking, because which almanac a household keeps
 * decides which dates we call auspicious. English first with the local name beside
 * it — the audience is pan-India now, and several regions offer almanacs whose names
 * are unfamiliar outside them.
 */
export function PanjikaPrompt({ onDone }: { onDone: (school: PanjikaId | null) => void }) {
  const { region } = useRegion();
  const [busy, setBusy] = useState(false);

  const choose = async (school: PanjikaId | null) => {
    setBusy(true);
    try {
      await api('/v1/me/panjika', { method: 'PATCH', body: JSON.stringify({ school }) });
    } catch { /* a failed preference save must never block a booking */ }
    onDone(school);
  };

  return (
    <div className="card" style={{ maxWidth: 620, margin: '0 auto', padding: 30 }}>
      <span className="kicker-pill">One-time question</span>
      <h1 style={{ fontSize: '1.7rem' }}>Which panchang does your family follow?</h1>
      <p className="muted" style={{ marginTop: 12 }}>
        Households in {region.name.en} follow more than one almanac, and they do not
        always agree on dates. We use yours to decide which days we mark auspicious.
      </p>

      <div className="grid" style={{ marginTop: 22, gap: 12 }}>
        {region.panjikas.map((p) => (
          <button key={p.id} className="pick" disabled={busy} onClick={() => choose(p.id)}>
            <div className="spread">
              <span className="bn">{p.english}</span>
              <span className="muted" style={{ fontWeight: 600 }}>{p.native}</span>
            </div>
            <div className="muted" style={{ fontSize: '.88rem', marginTop: 6 }}>{p.note}</div>
          </button>
        ))}
      </div>

      <button className="outline btn-block" style={{ marginTop: 16 }} disabled={busy}
              onClick={() => choose(null)}>
        I&apos;m not sure — show me all of them
      </button>

      <p className="faint" style={{ fontSize: '.82rem', marginTop: 18, marginBottom: 0 }}>
        You can change this any time. Bookings already made keep the panchang they were
        made with.
      </p>
    </div>
  );
}
