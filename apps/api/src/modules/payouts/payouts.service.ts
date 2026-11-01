import { ulid } from 'ulid';
import { eq, and, sql } from 'drizzle-orm';
import type { Db, Executor } from '../../db/client';
import { payouts, ledgerEntries, ledgerAccounts, panditProfiles } from '../../db/schema/index';
import type { LedgerService } from '../../domain/ledger';
import type { Leg } from '../../domain/ledger';
import { paise, DomainError, ErrorCode } from '@themaithil/contracts';
import { requirePayoutDestination } from '../purohit/payout-account';

export const INSTANT_PAYOUT_FEE_PAISE = 1000;   // ₹10, per the PRD

/**
 * Payouts.
 *
 *   net = gross − open cash dues − TDS carried from cash bookings − instant fee
 *
 * The `tds_carry` term is what makes the cash treatment in ADR 0004 close the loop:
 * on a cash booking we withhold against money we never held, so the withholding sits
 * as a carry and comes out of the next digital payout. Without recovering it here the
 * platform funds the purohit's tax out of its own pocket.
 *
 * The whole thing is one transaction: computing a payout and not recording it, or
 * recording it and not clearing the dues, are both worse than failing.
 */
export class PayoutService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * What is owed right now, broken down. Powers the earnings screen too - that read
   * has no reason to lock anything, so it takes the default `this.db`. `run()` below
   * passes its own locked `tx` instead, so the balance it pays out against is read
   * under the same lock that serializes it against a second concurrent payout run.
   */
  /**
   * Every purohit and what the platform owes them — the settlement ledger an admin
   * actually asks about: "has this person been paid?"
   *
   * The `ledger` tab shows raw double-entry rows, which are the truth and are
   * unreadable for this question: answering it meant summing entries by hand across
   * four types and two directions, per purohit. `preview` already does exactly that
   * arithmetic for one purohit; this runs it for all of them.
   *
   * ONE QUERY, not one per purohit. The obvious implementation — list purohits, call
   * `preview` in a loop — is a query per row on a screen that grows with the roster,
   * and CONTRIBUTING.md is explicit that no query belongs inside a loop. The grouping
   * `preview` does in JS is done here in SQL instead, so the two must agree: the
   * arithmetic below is the same four terms, and the test asserts they match.
   */
  async settlementOverview() {
    const rows = await this.db.execute(sql`
      WITH totals AS (
        SELECT la.owner_id AS pandit_id,
               SUM(CASE WHEN le.type = 'balance' AND le.direction = 'credit'
                        THEN le.amount_paise ELSE 0 END)              AS credited,
               SUM(CASE WHEN le.type = 'cash_settled_direct' AND le.direction = 'debit'
                        THEN le.amount_paise ELSE 0 END)              AS cash_direct,
               SUM(CASE WHEN le.type = 'cash_due' AND le.direction = 'debit'
                        THEN le.amount_paise ELSE 0 END)              AS dues_raised,
               SUM(CASE WHEN le.type = 'cash_recovery' AND le.direction = 'credit'
                        THEN le.amount_paise ELSE 0 END)              AS dues_recovered,
               SUM(CASE WHEN le.type = 'tds_carry' AND le.direction = 'debit'
                        THEN le.amount_paise ELSE 0 END)              AS tds_carry,
               SUM(CASE WHEN le.type = 'payout' AND le.direction = 'debit'
                        THEN le.amount_paise ELSE 0 END)              AS already_paid
          FROM ledger_entries le
          JOIN ledger_accounts la ON la.id = le.account_id
         WHERE la.owner_type = 'pandit'
         GROUP BY la.owner_id
      )
      SELECT u.id                                   AS "panditId",
             u.name                                 AS "name",
             u.phone                                AS "phone",
             (t.credited - t.cash_direct)::bigint   AS "grossPaise",
             (t.dues_raised - t.dues_recovered)::bigint AS "duesPaise",
             t.tds_carry::bigint                    AS "tdsCarryPaise",
             t.already_paid::bigint                 AS "alreadyPaidPaise",
             GREATEST(
               (t.credited - t.cash_direct)
               - (t.dues_raised - t.dues_recovered)
               - t.tds_carry
               - t.already_paid, 0
             )::bigint                              AS "netPayablePaise",
             (SELECT max(p.created_at) FROM payouts p WHERE p.pandit_id = u.id)
                                                    AS "lastPayoutAt"
        FROM totals t
        JOIN users u ON u.id = t.pandit_id
       ORDER BY "netPayablePaise" DESC, u.name
    `);

    const list = ((rows as unknown as { rows?: unknown[] }).rows ?? rows) as Array<{
      panditId: string; name: string | null; phone: string;
      grossPaise: string | number; duesPaise: string | number;
      tdsCarryPaise: string | number; alreadyPaidPaise: string | number;
      netPayablePaise: string | number; lastPayoutAt: string | null;
    }>;

    /*
     * Numerics arrive from the driver as strings. Coerced here rather than at the
     * boundary, because a money figure silently becoming "1234" instead of 1234 is
     * the kind of thing that renders fine and sorts wrong.
     */
    const n = (v: string | number) => Number(v ?? 0);
    const settlements = list.map((r) => ({
      panditId: r.panditId,
      name: r.name,
      phone: r.phone,
      grossPaise: n(r.grossPaise),
      duesPaise: n(r.duesPaise),
      tdsCarryPaise: n(r.tdsCarryPaise),
      alreadyPaidPaise: n(r.alreadyPaidPaise),
      netPayablePaise: n(r.netPayablePaise),
      lastPayoutAt: r.lastPayoutAt,
      /** The question the screen exists to answer, precomputed so it cannot drift. */
      settled: n(r.netPayablePaise) === 0,
    }));

    return {
      settlements,
      outstandingPaise: settlements.reduce((s, r) => s + r.netPayablePaise, 0),
      owedCount: settlements.filter((r) => !r.settled).length,
    };
  }

  async preview(panditId: string, exec: Executor = this.db) {
    const rows = await exec.select({
      type: ledgerEntries.type,
      direction: ledgerEntries.direction,
      total: sql<string>`SUM(${ledgerEntries.amountPaise})`,
    })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(and(
        eq(ledgerAccounts.ownerType, 'pandit'),
        eq(ledgerAccounts.ownerId, panditId),
      ))
      .groupBy(ledgerEntries.type, ledgerEntries.direction);

    const sum = (type: string, direction: 'debit' | 'credit') =>
      Number(rows.find((r) => r.type === type && r.direction === direction)?.total ?? 0);

    // Earned but not yet paid out. `cash_settled_direct` removes the notional cash
    // credit, since the purohit already holds that money.
    const gross = sum('balance', 'credit') - sum('cash_settled_direct', 'debit');
    const dues = sum('cash_due', 'debit') - sum('cash_recovery', 'credit');
    const tdsCarry = sum('tds_carry', 'debit');
    const alreadyPaid = sum('payout', 'debit');

    const payable = Math.max(gross - dues - tdsCarry - alreadyPaid, 0);
    return {
      grossPaise: gross,
      duesPaise: dues,
      tdsCarryPaise: tdsCarry,
      alreadyPaidPaise: alreadyPaid,
      netPayablePaise: payable,
    };
  }

  /**
   * `preview()` used to run before this transaction even opened - an unlocked
   * aggregate read of the purohit's balance, with nothing stopping a second,
   * DIFFERENT payout run (a weekly batch job and a manually-tapped instant payout
   * are the realistic pair) from reading that exact same stale balance before either
   * had posted anything, and both posting a full payout against it. The
   * `idempotencyKey` on `ledger.post` only catches an EXACT repeat of the same
   * panditId+periodEnd+instant triple; two runs with different parameters draining
   * the same underlying balance don't collide on it at all.
   *
   * Locking `panditProfiles` for this purohit for the whole operation - the
   * destination check, `preview()`, and the post - serializes any two `run()` calls
   * for the same purohit regardless of what periodEnd or instant they were given. A
   * second call blocks on `FOR UPDATE` until the first commits, then computes
   * `preview()` against ledger state that already includes the first payout's legs.
   */
  async run(args: {
    panditId: string; periodStart: string; periodEnd: string; instant?: boolean;
  }) {
    return this.db.transaction(async (tx) => {
      /*
       * Refuse before computing anything.
       *
       * Until now this would happily post a full double-entry payout — debit the
       * purohit, credit the platform, clear their cash dues, re-enable cash work — and
       * write a `payouts` row with status 'pending' and `aggregator_ref` null. The
       * ledger would say the purohit had been paid. No money would have moved, because
       * `linked_account_id` was null and nothing had ever set it, and the row would sit
       * 'pending' forever with the balance already deducted.
       *
       * A payout with no destination is not a payout, and recording one is worse than
       * failing: it makes the ledger disagree with reality in the direction that
       * disadvantages the purohit.
       */
      const [profile] = await tx.select({ linked: panditProfiles.linkedAccountId })
        .from(panditProfiles).where(eq(panditProfiles.userId, args.panditId)).for('update');
      requirePayoutDestination(profile?.linked);

      const p = await this.preview(args.panditId, tx);
      const fee = args.instant ? INSTANT_PAYOUT_FEE_PAISE : 0;
      const net = p.netPayablePaise - fee;

      if (net <= 0) {
        throw new DomainError(
          ErrorCode.PAYMENT_NOT_CAPTURED,
          'nothing is payable for this period',
          { ...p, fee },
        );
      }

      const legs: Leg[] = [];
      const pandit = { type: 'pandit' as const, ownerId: args.panditId };
      const platform = { type: 'platform' as const, ownerId: null };

      legs.push(
        { account: pandit, direction: 'debit', amount: paise(net), type: 'payout' },
        { account: platform, direction: 'credit', amount: paise(net), type: 'payout' },
      );

      if (p.duesPaise > 0) {
        legs.push(
          { account: platform, direction: 'debit', amount: paise(p.duesPaise), type: 'cash_recovery' },
          { account: pandit, direction: 'credit', amount: paise(p.duesPaise), type: 'cash_recovery' },
        );
      }
      if (fee > 0) {
        legs.push(
          { account: pandit, direction: 'debit', amount: paise(fee), type: 'instant_payout_fee' },
          { account: platform, direction: 'credit', amount: paise(fee), type: 'instant_payout_fee' },
        );
      }

      await this.ledger.post(tx, {
        kind: args.instant ? 'instant_payout' : 'weekly_payout',
        idempotencyKey: `payout:${args.panditId}:${args.periodEnd}${args.instant ? ':instant' : ''}`,
        legs,
      });

      const id = ulid();
      await tx.insert(payouts).values({
        id,
        panditId: args.panditId,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        grossPaise: p.grossPaise,
        duesRecoveredPaise: p.duesPaise,
        tdsPaise: p.tdsCarryPaise,
        feePaise: fee,
        netPaise: net,
        status: 'pending',
      });

      // Clearing dues can re-enable cash work; the credit limit is what paused it.
      if (p.duesPaise > 0) {
        await tx.update(panditProfiles).set({ cashJobsEnabled: true })
          .where(eq(panditProfiles.userId, args.panditId));
      }

      return { payoutId: id, netPaise: net, ...p, feePaise: fee };
    });
  }

  /** Pauses cash work once open dues reach the purohit's credit limit. */
  async enforceCreditLimit(panditId: string): Promise<boolean> {
    const profile = (await this.db.select().from(panditProfiles)
      .where(eq(panditProfiles.userId, panditId)).limit(1))[0];
    if (!profile) return false;

    const dues = await this.ledger.openDues(panditId);
    const overLimit = dues >= Number(profile.cashCreditLimitPaise);
    if (overLimit === !profile.cashJobsEnabled) return overLimit;

    await this.db.update(panditProfiles)
      .set({ cashJobsEnabled: !overLimit })
      .where(eq(panditProfiles.userId, panditId));
    return overLimit;
  }
}
