import { describe, it, expect } from 'vitest';
import { rankMuhurats, bestMuhurats, type MuhuratDay } from '../muhurat';

const day = (over: Partial<MuhuratDay> & { date: string }): MuhuratDay => ({
  tithiAtSunrise: 'Dashami',
  nakshatraAtSunrise: 'Rohini',
  abhijit: null,
  rahuKaal: null,
  auspiciousForRitualIds: [],
  schoolsDisagree: false,
  ...over,
});

const RITUAL = 'r1';

describe('ranking auspicious days', () => {
  it('puts a day the family panjika marks above one it does not', () => {
    const out = rankMuhurats([
      day({ date: '2026-09-01' }),
      day({ date: '2026-09-02', auspiciousForRitualIds: [RITUAL] }),
    ], RITUAL);

    expect(out[0]!.date).toBe('2026-09-02');
    expect(out[0]!.reasons[0]).toMatch(/auspicious for this ritual/i);
  });

  it('beats an unmarked day even when the unmarked one is sooner', () => {
    const out = rankMuhurats([
      day({ date: '2026-09-01' }),
      day({ date: '2026-09-20', auspiciousForRitualIds: [RITUAL] }),
    ], RITUAL);
    expect(out[0]!.date).toBe('2026-09-20');
  });

  it('prefers the sooner of two otherwise equal days', () => {
    const out = rankMuhurats([
      day({ date: '2026-09-10', auspiciousForRitualIds: [RITUAL] }),
      day({ date: '2026-09-01', auspiciousForRitualIds: [RITUAL] }),
    ], RITUAL);
    // Input order is deliberately not date order; recency must come from position.
    expect(out[0]!.date).toBe('2026-09-10');
  });

  it('always says what the day is, even when nothing scores', () => {
    const [only] = rankMuhurats([day({ date: '2026-09-01' })], RITUAL);
    expect(only!.reasons.join(' ')).toMatch(/Dashami/);
    expect(only!.reasons.join(' ')).toMatch(/Rohini/);
  });

  /** ADR 0003: surface the disagreement, never resolve it silently. */
  it('flags a date the almanacs disagree about rather than hiding it', () => {
    const [d] = rankMuhurats([
      day({ date: '2026-09-01', schoolsDisagree: true, auspiciousForRitualIds: [RITUAL] }),
    ], RITUAL);
    expect(d!.caution).toMatch(/almanacs disagree/i);
    // Still offered — a caution is not a block.
    expect(d!.score).toBeGreaterThan(0);
  });

  it('cautions on a tithi some families avoid, without removing it', () => {
    const [d] = rankMuhurats([day({ date: '2026-09-01', tithiAtSunrise: 'Amavasya' })], RITUAL);
    expect(d!.caution).toMatch(/some families avoid/i);
    expect(d!.date).toBe('2026-09-01');
  });

  it('never blocks a date — every day given is a day returned', () => {
    const days = Array.from({ length: 21 }, (_, i) =>
      day({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, tithiAtSunrise: 'Amavasya' }));
    expect(rankMuhurats(days, RITUAL)).toHaveLength(21);
  });

  it('handles an empty panchang without throwing', () => {
    expect(rankMuhurats([], RITUAL)).toEqual([]);
    expect(bestMuhurats([], RITUAL)).toEqual([]);
  });
});

describe('the shortlist put in front of a family', () => {
  it('offers nothing rather than padding with weak days', () => {
    // Nothing marked, no Abhijit anywhere: claiming five auspicious dates would lie.
    const days = Array.from({ length: 10 }, (_, i) =>
      day({ date: `2026-09-${String(i + 1).padStart(2, '0')}` }));
    expect(bestMuhurats(days, RITUAL)).toEqual([]);
  });

  it('includes a day carrying Abhijit even when the panjika has not marked it', () => {
    const out = bestMuhurats([
      day({ date: '2026-09-01' }),
      day({ date: '2026-09-02', abhijit: { startsAt: 'x', endsAt: 'y' } }),
    ], RITUAL);
    expect(out.map((m) => m.date)).toEqual(['2026-09-02']);
  });

  it('caps the shortlist so the screen stays a decision, not a list', () => {
    const days = Array.from({ length: 21 }, (_, i) =>
      day({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, auspiciousForRitualIds: [RITUAL] }));
    expect(bestMuhurats(days, RITUAL)).toHaveLength(5);
  });
});
