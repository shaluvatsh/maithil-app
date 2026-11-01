import { ulid } from 'ulid';
import { eq, and, sql, isNull, lt } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { reviews, bookings, panditProfiles } from '../../db/schema/index';
import { DomainError, ErrorCode } from '@themaithil/contracts';

const PUBLISH_AFTER_HOURS = 72;

/**
 * Double-blind reviews.
 *
 * Neither side sees the other's review until both have submitted, or 72 hours pass.
 * The point is to stop retaliatory scoring: a purohit who knows they were rated three
 * stars rates the devotee three stars back, and both numbers stop meaning anything.
 *
 * Samagri is rated separately from the purohit, so a bad kit never drags down the
 * person who performed the ritual well.
 */
export class ReviewsService {
  constructor(private readonly db: Db) {}

  async submit(args: {
    bookingId: string;
    authorId: string;
    panditStars?: number | undefined;
    punctualityStars?: number | undefined;
    samagriStars?: number | undefined;
    devoteeStars?: number | undefined;
    text?: string | undefined;
  }) {
    const booking = (await this.db.select().from(bookings)
      .where(eq(bookings.id, args.bookingId)).limit(1))[0];
    if (!booking) throw new DomainError(ErrorCode.NOT_FOUND, 'booking not found');

    const author =
      booking.devoteeId === args.authorId ? 'devotee'
      : booking.panditId === args.authorId ? 'pandit'
      : null;
    if (!author) throw new DomainError(ErrorCode.FORBIDDEN, 'not your booking');

    if (booking.state !== 'completed' && booking.state !== 'reviewed') {
      throw new DomainError(
        ErrorCode.INVALID_TRANSITION,
        'you can review a booking once it has been completed',
        { state: booking.state },
      );
    }

    const existing = await this.db.select().from(reviews)
      .where(and(eq(reviews.bookingId, args.bookingId), eq(reviews.author, author)))
      .limit(1);
    if (existing[0]) {
      throw new DomainError(ErrorCode.IDEMPOTENCY_CONFLICT, 'you have already reviewed this');
    }

    await this.db.insert(reviews).values({
      id: ulid(),
      bookingId: args.bookingId,
      author,
      panditStars: author === 'devotee' ? args.panditStars ?? null : null,
      punctualityStars: author === 'devotee' ? args.punctualityStars ?? null : null,
      samagriStars: author === 'devotee' ? args.samagriStars ?? null : null,
      devoteeStars: author === 'pandit' ? args.devoteeStars ?? null : null,
      text: args.text ?? null,
    });

    // Both in? Publish immediately rather than making everyone wait out the window.
    const both = await this.db.select().from(reviews)
      .where(eq(reviews.bookingId, args.bookingId));
    if (both.length === 2) await this.publish(args.bookingId);

    return { published: both.length === 2 };
  }

  /** Publishes a booking's reviews and folds the rating into the purohit's totals. */
  async publish(bookingId: string): Promise<void> {
    const now = new Date().toISOString();
    const published = await this.db.update(reviews)
      .set({ publishedAt: now })
      .where(and(eq(reviews.bookingId, bookingId), isNull(reviews.publishedAt)))
      .returning();

    const booking = (await this.db.select().from(bookings)
      .where(eq(bookings.id, bookingId)).limit(1))[0];
    if (!booking) return;

    for (const r of published) {
      if (r.author !== 'devotee' || r.panditStars == null) continue;
      // rating_sum / rating_count are a materialised aggregate; search smooths them
      // with a Bayesian prior so a purohit with two reviews cannot top the list.
      await this.db.update(panditProfiles).set({
        ratingSum: sql`${panditProfiles.ratingSum} + ${r.panditStars}`,
        ratingCount: sql`${panditProfiles.ratingCount} + 1`,
        // First real review earned - retire the cold-start boost one step.
        newSupplyBoostRemaining: sql`GREATEST(${panditProfiles.newSupplyBoostRemaining} - 1, 0)`,
      }).where(eq(panditProfiles.userId, booking.panditId));
    }

    if (booking.state === 'completed') {
      await this.db.update(bookings).set({ state: 'reviewed' })
        .where(eq(bookings.id, bookingId));
    }
  }

  /** Job: publish one-sided reviews once the window closes. */
  async publishExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - PUBLISH_AFTER_HOURS * 3600_000).toISOString();
    const stale = await this.db.select({ bookingId: reviews.bookingId })
      .from(reviews)
      .where(and(isNull(reviews.publishedAt), lt(reviews.submittedAt, cutoff)));

    const ids = [...new Set(stale.map((s) => s.bookingId))];
    for (const id of ids) await this.publish(id);
    return ids.length;
  }

  /** Published reviews for a purohit's profile. */
  async forPandit(panditId: string) {
    return this.db.select({
      id: reviews.id,
      panditStars: reviews.panditStars,
      punctualityStars: reviews.punctualityStars,
      samagriStars: reviews.samagriStars,
      text: reviews.text,
      publishedAt: reviews.publishedAt,
    })
      .from(reviews)
      .innerJoin(bookings, eq(bookings.id, reviews.bookingId))
      .where(and(
        eq(bookings.panditId, panditId),
        eq(reviews.author, 'devotee'),
        sql`${reviews.publishedAt} IS NOT NULL`,
      ))
      .orderBy(sql`${reviews.publishedAt} DESC`)
      .limit(50);
  }
}
