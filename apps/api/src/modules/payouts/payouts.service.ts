import { ulid } from 'ulid';
import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { payouts, ledgerEntries, ledgerAccounts, panditProfiles } from '../../db/schema/index';
import type { LedgerService } from '../../domain/ledger';
import type { Leg } from '../../domain/ledger';
import { paise, DomainError, ErrorCode, type Paise } from '@themaithil/contracts';
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

  /** What is owed right now, broken down. Powers the earnings screen too. */
  async preview(panditId: string) {
    const rows = await this.db.select({
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

  async run(args: {
    panditId: string; periodStart: string; periodEnd: string; instant?: boolean;
  }) {
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
    const [profile] = await this.db.select({ linked: panditProfiles.linkedAccountId })
      .from(panditProfiles).where(eq(panditProfiles.userId, args.panditId)).limit(1);
    requirePayoutDestination(profile?.linked);

    const p = await this.preview(args.panditId);
    const fee = args.instant ? INSTANT_PAYOUT_FEE_PAISE : 0;
    const net = p.netPayablePaise - fee;

    if (net <= 0) {
      throw new DomainError(
        ErrorCode.PAYMENT_NOT_CAPTURED,
        'nothing is payable for this period',
        { ...p, fee },
      );
    }

    return this.db.transaction(async (tx) => {
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
