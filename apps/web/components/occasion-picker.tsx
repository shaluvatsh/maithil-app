'use client';
import { useState } from 'react';
import { OCCASIONS, getOccasion, type Occasion } from '@themaithil/region';

/**
 * The minimum this component reads. Generic over the caller's fuller type so the
 * page keeps one `Ritual` shape and the picker does not force a second one — the
 * component depends on the fields it uses, not on the page.
 */
export interface OccasionRitualShape {
  id: string;
  slug: string;
  name: string;
  durationMin: number;
  priceBand: { minPaise: number };
}

/**
 * The front door.
 *
 * A family knows their situation, not the name of the rite. Asking them to search a
 * catalogue of Sanskrit names is asking them to already know the answer they came
 * for — and it is what every competitor does.
 *
 * Two screens: pick the occasion, then see the two or three rituals it means, each
 * with what it does and whether you need more than one. The catalogue is still
 * there for anyone who does know what they want.
 */
export function OccasionPicker<R extends OccasionRitualShape>({
  rituals, money, onPick, onBrowse,
}: {
  rituals: R[];
  money: (paise: number) => string;
  onPick: (r: R) => void;
  onBrowse: () => void;
}) {
  const [occasion, setOccasion] = useState<Occasion | null>(null);

  if (!occasion) {
    return (
      <div className="occ">
        <h2 className="occ-q">What is the occasion?</h2>
        <p className="occ-sub">
          Tell us what is happening and we will tell you which pooja it means — you
          do not need to know the name.
        </p>

        <div className="occ-grid">
          {OCCASIONS.map((o) => (
            <button key={o.id} className="occ-card" onClick={() => setOccasion(o)}>
              <span className="ic" aria-hidden="true">{o.emoji}</span>
              <span className="lb">{o.label}</span>
              <span className="bl">{o.blurb}</span>
            </button>
          ))}
        </div>

        <button className="occ-skip" onClick={onBrowse}>
          I know which pooja I want — show me everything
        </button>
      </div>
    );
  }

  // Only what this city actually sells, in the occasion's own priority order.
  const suggested = occasion.rituals
    .map((or) => ({ or, ritual: rituals.find((r) => r.slug === or.slug) }))
    .filter((x): x is { or: typeof occasion.rituals[number]; ritual: R } =>
      x.ritual !== undefined);

  return (
    <div className="occ">
      <button className="occ-back" onClick={() => setOccasion(null)}>
        ← All occasions
      </button>

      <h2 className="occ-q">
        <span aria-hidden="true">{occasion.emoji}</span> {occasion.label}
      </h2>

      {/* The question every family has and nobody in this category answers. */}
      <div className="occ-guide">{occasion.guidance}</div>

      {suggested.length === 0 ? (
        <div className="card empty-state">
          <h3>Nothing listed for this yet in your city</h3>
          <p className="muted">Browse everything, or change your city in the header.</p>
          <button className="btn" onClick={onBrowse}>Browse all services</button>
        </div>
      ) : (
        <div className="occ-rituals">
          {suggested.map(({ or, ritual }) => (
            <button key={ritual.id} className="occ-ritual" onClick={() => onPick(ritual)}>
              <div className="top">
                <span className="nm">{ritual.name}</span>
                <span className={`wt ${or.weight}`}>
                  {or.weight === 'core' ? 'Usually this one'
                    : or.weight === 'often-with' ? 'Often added'
                    : 'Some families'}
                </span>
              </div>
              <div className="does">{or.does}</div>
              <div className="meta">
                {Math.round(ritual.durationMin / 60) || 1} hr
                {ritual.durationMin >= 120 ? 's' : ''} · from {money(ritual.priceBand.minPaise)}
              </div>
            </button>
          ))}
        </div>
      )}

      <button className="occ-skip" onClick={onBrowse}>
        None of these — show me everything
      </button>
    </div>
  );
}

export { getOccasion };
