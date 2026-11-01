import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { Logger } from '@nestjs/common';
import type { Db } from '../db/client';
import { kycRecords } from '../db/schema/index';
import type { ObjectStore } from '../modules/storage/object-store';

/**
 * Deletes identity document images thirty days after a verification decision.
 *
 * ADR 0010 promises this, `kyc_records.doc_purge_after` is written on every
 * decision, the admin console renders "Null once purged" as a real state, and the
 * `ObjectStore` port carries a `delete` whose docstring says "used by the purge job
 * once a decision is 30 days old".
 *
 * There was no purge job. Nothing in the repository called `store.delete`. So every
 * scan of every purohit's Aadhaar, PAN and address proof was retained indefinitely
 * — for a platform whose own architecture decision record calls the retention limit
 * non-negotiable, and under a regime (DPDP) that treats storage limitation as an
 * obligation rather than a preference.
 *
 * WHAT IS DELETED AND WHAT SURVIVES. Only the image. The `kyc_records` row stays,
 * with its type, its last four digits, its decision, its reviewer and its notes —
 * that is the audit trail proving a human checked this person, and it is exactly
 * what an operator needs when a purohit's approval is questioned two years later.
 * The document itself is what we have no further business holding.
 */
export class KycPurgeJob {
  private readonly log = new Logger('kyc-purge');

  constructor(
    private readonly db: Db,
    private readonly store: ObjectStore,
  ) {}

  async run(): Promise<number> {
    const due = await this.db.select({ id: kycRecords.id, docKey: kycRecords.docKey })
      .from(kycRecords)
      .where(and(
        isNotNull(kycRecords.docKey),
        isNotNull(kycRecords.docPurgeAfter),
        lte(kycRecords.docPurgeAfter, new Date().toISOString()),
      ));

    let purged = 0;
    for (const row of due) {
      try {
        await this.store.delete(row.docKey!);
      } catch (e) {
        /*
         * A storage failure must not clear the reference.
         *
         * Nulling `doc_key` after a failed delete would leave the object in the
         * bucket with nothing in the database pointing at it — an identity document
         * we can neither serve nor ever find again to remove. Leaving the row
         * untouched means the next daily run retries it, which is the only outcome
         * that converges on the document actually being gone.
         */
        this.log.error(
          `could not delete ${row.docKey} (will retry on the next run): ${
            e instanceof Error ? e.message : e}`,
        );
        continue;
      }

      await this.db.update(kycRecords)
        .set({ docKey: null, docPurgeAfter: null })
        .where(eq(kycRecords.id, row.id));
      purged++;
    }

    return purged;
  }
}
