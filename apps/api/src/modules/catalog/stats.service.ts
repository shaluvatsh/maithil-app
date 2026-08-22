import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { users, panditProfiles, rituals, cities } from '../../db/schema/index';

/**
 * The numbers under the hero, counted rather than claimed.
 *
 * The hero read "4.8★ average · 500 verified pandits · 50,000+ families served".
 * None of the three was measured. There were no reviews in the database at all, so
 * the average was of nothing; the pandit count was a round number somebody liked;
 * and no families had been served, because nothing has launched.
 *
 * Invented social proof is a worse category of wrong than an invented price. A
 * wrong price is corrected at checkout — a devotee finds out. A fabricated rating
 * is never corrected, is the specific thing consumer-protection rules single out,
 * and is the one claim a marketplace cannot recover from being caught on.
 *
 * So this counts what is actually there. A number that resolves to zero is
 * returned as zero and the UI omits that line: an honest gap beats a flattering
 * fiction, and it also creates the pressure to go and earn the number.
 */
export class StatsService {
  constructor(private readonly db: Db) {}

  async summary() {
    // One round trip. Three COUNT queries to render one line of text is the kind of
    // thing that is free at this size and embarrassing at scale.
    const [row] = await this.db
      .select({
        verifiedPandits: sql<number>`(
          SELECT count(*)::int FROM ${panditProfiles}
           WHERE ${panditProfiles.kycStatus} = 'verified'
        )`,
        rituals: sql<number>`(
          SELECT count(*)::int FROM ${rituals} WHERE ${rituals.active} = TRUE
        )`,
        cities: sql<number>`(SELECT count(*)::int FROM ${cities})`,
        /**
         * Completed bookings, not registrations. "Families served" has to mean a
         * puja that actually happened, or it is a signup counter wearing a
         * trustworthy word.
         */
        familiesServed: sql<number>`(
          SELECT count(DISTINCT devotee_id)::int FROM bookings WHERE state = 'completed'
        )`,
      })
      .from(users)
      .limit(1);

    return {
      verifiedPandits: Number(row?.verifiedPandits ?? 0),
      rituals: Number(row?.rituals ?? 0),
      cities: Number(row?.cities ?? 0),
      familiesServed: Number(row?.familiesServed ?? 0),
    };
  }
}
