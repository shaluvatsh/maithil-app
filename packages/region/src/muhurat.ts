/**
 * Ranking auspicious days.
 *
 * The panchang engine has been computing tithi, nakshatra, Abhijit and Rahu Kaal all
 * along, and the booking flow rendered it as a small "Auspicious" tag on a flat strip
 * of 21 dates — decoration on top of a calendar. That is backwards. The date is the
 * thing families agonise over, and "waiting to ask someone about a good date" is the
 * single most common reason a booking is delayed.
 *
 * So: never show a blank calendar. Show the good days first, ranked, each with the
 * reason it is good — and keep every other date one tap away, because the decision
 * is still theirs.
 *
 * Pure and dependency-free, like the rest of this package: the same function ranks
 * for the web app today and for the mobile apps later, and it can be tested without
 * a database.
 */
export interface MuhuratDay {
  date: string;
  tithiAtSunrise: string;
  nakshatraAtSunrise: string;
  abhijit: { startsAt: string; endsAt: string } | null;
  rahuKaal: { startsAt: string; endsAt: string } | null;
  /** Ritual ids this day is flagged auspicious for, by the chosen panjika. */
  auspiciousForRitualIds: string[];
  /** True where the region's almanacs do not agree about this date. */
  schoolsDisagree: boolean;
}

export interface RankedMuhurat {
  date: string;
  /** 0–100. Comparable only within one result set. */
  score: number;
  /** Why this day, in the order a purohit would say it. */
  reasons: string[];
  /** Something the family should know before choosing. Never a reason to block. */
  caution: string | null;
  hasAbhijit: boolean;
  abhijit: { startsAt: string; endsAt: string } | null;
}

const W = {
  /** By far the strongest signal: the family's own almanac marks it. */
  auspiciousForRitual: 55,
  /** The universally auspicious midday window. */
  abhijit: 25,
  /** Sooner is gently better — a family that wants a date usually wants it soon. */
  soon: 20,
} as const;

/**
 * Days the tradition treats as unsuitable for most auspicious work. Kept small and
 * advisory: this shapes ORDER, never availability. Blocking a date the family has
 * chosen for their own reasons would be the platform overruling the household, which
 * is exactly the tone DESIGN.md rules out.
 */
const INAUSPICIOUS_TITHI = ['amavasya', 'chaturdashi', 'ashtami'];

const isInauspicious = (tithi: string) =>
  INAUSPICIOUS_TITHI.some((t) => tithi.toLowerCase().includes(t));

/**
 * Ranks the days a ritual could be performed.
 *
 * `horizonDays` scales the recency term: with 21 days on offer, day 1 should not
 * outrank day 3 by much, but day 1 should clearly outrank day 20.
 */
export function rankMuhurats(
  days: readonly MuhuratDay[],
  ritualId: string,
  opts: { limit?: number } = {},
): RankedMuhurat[] {
  if (days.length === 0) return [];
  const span = Math.max(days.length - 1, 1);

  const ranked = days.map((d, i) => {
    const auspicious = d.auspiciousForRitualIds.includes(ritualId);
    const reasons: string[] = [];
    let score = 0;

    if (auspicious) {
      score += W.auspiciousForRitual;
      reasons.push('Marked auspicious for this ritual by your panjika');
    }
    if (d.abhijit) {
      score += W.abhijit;
      reasons.push('Abhijit muhurat falls in the middle of the day');
    }
    score += Math.round(W.soon * (1 - i / span));

    // Always say what the day IS, even when nothing scores — a date with no reason
    // attached tells the family nothing.
    if (d.tithiAtSunrise) reasons.push(`${d.tithiAtSunrise} at sunrise`);
    if (d.nakshatraAtSunrise) reasons.push(`${d.nakshatraAtSunrise} nakshatra`);

    let caution: string | null = null;
    if (d.schoolsDisagree) {
      // Surfacing the disagreement rather than resolving it silently is the whole
      // point of holding three almanacs. See ADR 0003.
      caution = 'The almanacs disagree about this date — check with your family';
    } else if (isInauspicious(d.tithiAtSunrise)) {
      caution = `${d.tithiAtSunrise} — some families avoid this tithi`;
      score -= 15;
    }

    return {
      date: d.date,
      score: Math.max(0, Math.min(100, score)),
      reasons,
      caution,
      hasAbhijit: Boolean(d.abhijit),
      abhijit: d.abhijit,
    };
  });

  // Ties break by date, so the order is stable and the soonest of two equal days
  // comes first.
  ranked.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date));
  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}

/**
 * The days worth putting in front of someone.
 *
 * Returns nothing rather than padding with weak days: offering six "auspicious"
 * dates when only two are actually marked would make the feature a lie, and the
 * caller falls back to the full calendar.
 */
export function bestMuhurats(
  days: readonly MuhuratDay[],
  ritualId: string,
  limit = 5,
): RankedMuhurat[] {
  const strong = rankMuhurats(days, ritualId).filter(
    (m) => m.reasons.some((r) => r.startsWith('Marked auspicious')) || m.hasAbhijit,
  );
  return strong.slice(0, limit);
}
