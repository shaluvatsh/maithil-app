import { describe, it, expect } from 'vitest';
import { estimateTravel, haversineKm } from '../travel';

/**
 * The number that decides whether a purohit can take a job.
 *
 * `applyTravelBuffer` has never once fired in production — guarded by
 * `travelMinutes <= region.travelGapMinutes` with a caller that passes a hardcoded
 * 25, below every city's gap — so a purohit has been bookable back-to-back whether
 * the two homes were 2 km or 25 km apart. These pin the replacement.
 */
const exact = (lat: number, lng: number) => ({ lat, lng, precision: 'exact' as const });

describe('haversine', () => {
  it('is zero for a point against itself', () => {
    expect(haversineKm({ lat: 22.5, lng: 88.3 }, { lat: 22.5, lng: 88.3 })).toBe(0);
  });

  it('measures a few km across a city', () => {
    // Gariahat to Salt Lake, roughly.
    const km = haversineKm({ lat: 22.5148, lng: 88.3639 }, { lat: 22.5800, lng: 88.4200 });
    expect(km).toBeGreaterThan(7);
    expect(km).toBeLessThan(12);
  });
});

describe('travel time is floored, never optimistic', () => {
  it("never returns less than the city's minimum turnaround", () => {
    // Same building: zero distance, but a purohit still has to pack up and be let in.
    const t = estimateTravel({
      from: exact(22.5148, 88.3639), to: exact(22.5148, 88.3639), citySlug: 'kolkata',
    });
    expect(t.minutes).toBe(30);   // kolkata travelGapMinutes
  });

  it('exceeds the floor once the distance genuinely warrants it', () => {
    const t = estimateTravel({
      from: exact(22.4800, 88.3000), to: exact(22.6200, 88.4400), citySlug: 'kolkata',
    });
    expect(t.minutes).toBeGreaterThan(30);
  });

  it('scales with distance', () => {
    const near = estimateTravel({
      from: exact(22.5148, 88.3639), to: exact(22.5300, 88.3700), citySlug: 'kolkata',
    });
    const far = estimateTravel({
      from: exact(22.5148, 88.3639), to: exact(22.6500, 88.4800), citySlug: 'kolkata',
    });
    expect(far.minutes).toBeGreaterThan(near.minutes);
  });

  /**
   * The reason precision is carried around at all. Two `city`-precision addresses
   * are the SAME point, so the distance between them is zero — not "roughly zero",
   * actually false. Trusting it would let a purohit be booked across the city with
   * no gap at all.
   */
  it('adds slack when a coordinate is only as good as its city', () => {
    const point = { lat: 22.5726, lng: 88.3639 };
    const coarse = estimateTravel({
      from: { ...point, precision: 'city' },
      to: { ...point, precision: 'city' },
      citySlug: 'kolkata',
    });
    expect(coarse.minutes).toBeGreaterThan(30);
    expect(coarse.precision).toBe('city');
  });

  it('takes the weaker precision of the two endpoints', () => {
    const t = estimateTravel({
      from: exact(22.5148, 88.3639),
      to: { lat: 22.5300, lng: 88.3700, precision: 'pincode' },
      citySlug: 'kolkata',
    });
    expect(t.precision).toBe('pincode');
  });

  /** Cities differ: Mumbai's arterials are not Kolkata's lanes. */
  it('uses the city\'s own floor', () => {
    const kol = estimateTravel({
      from: exact(22.5148, 88.3639), to: exact(22.5148, 88.3639), citySlug: 'kolkata',
    });
    const mum = estimateTravel({
      from: exact(19.0760, 72.8777), to: exact(19.0760, 72.8777), citySlug: 'mumbai',
    });
    expect(mum.minutes).toBeGreaterThan(kol.minutes);
  });
});
