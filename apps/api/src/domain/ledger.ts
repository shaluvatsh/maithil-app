import { ulid } from 'ulid';
import { eq, and, sql } from 'drizzle-orm';
import type { Db, Executor } from '../db/client';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema/index';
import {
  type Paise, DomainError, ErrorCode,
  type LedgerEntryType, type LedgerAccountType,
} from '@themaithil/contracts';

export interface Leg {
  account: { type: LedgerAccountType; ownerId?: string | null };
  direction: 'debit' | 'credit';
  amount: Paise;
  type: LedgerEntryType;
  meta?: Record<string, unknown>;
}

/**
 * Double-entry ledger. See ADR 0004.
 *
 * Rules, all enforced here and again in SQL (9999_guards.sql):
 *  - every transaction balances
 *  - amounts are positive; direction carries the sign
 *  - entries are append-only; corrections are compensating entries
 *  - balances are DERIVED, never stored
 */
export class LedgerService {
  constructor(private readonly db: Db) {}

  /** Resolve or lazily create an account. Accounts are cheap; races are handled. */
  async accountId(
    tx: Executor,
    type: LedgerAccountType,
    ownerId?: string | null,
  ): Promise<string> {
    const existing = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(
        eq(ledgerAccounts.ownerType, type),
        ownerId == null
          ? sql`${ledgerAccounts.ownerId} IS NULL`
          : eq(ledgerAccounts.ownerId, ownerId),
      ))
      .limit(1);
    if (existing[0]) return existing[0].id;

    const id = ulid();
    await tx.insert(ledgerAccounts)
      .values({ id, ownerType: type, ownerId: ownerId ?? null })
      .onConflictDoNothing();
    const after = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(
        eq(ledgerAccounts.ownerType, type),
        ownerId == null
          ? sql`${ledgerAccounts.ownerId} IS NULL`
          : eq(ledgerAccounts.ownerId, ownerId),
      ))
      .limit(1);
    return after[0]!.id;
  }

  /**
   * Post a balanced transaction. MUST be called inside an existing transaction so
   * the ledger write is atomic with whatever state change caused it.
   */
  async post(tx: Executor, args: {
    kind: string;
    bookingId?: string | null;
    description?: string;
    idempotencyKey?: string;
    legs: Leg[];
  }): Promise<string> {
    const debits = args.legs.filter((l) => l.direction === 'debit')
      .reduce((a, l) => a + l.amount, 0);
    const credits = args.legs.filter((l) => l.direction === 'credit')
      .reduce((a, l) => a + l.amount, 0);

    if (args.legs.length === 0) {
      throw new DomainError(ErrorCode.LEDGER_IMBALANCE, 'refusing to post an empty transaction');
    }
    if (debits !== credits) {
      throw new DomainError(
        ErrorCode.LEDGER_IMBALANCE,
        `transaction does not balance: debits ${debits} vs credits ${credits}`,
        { kind: args.kind, debits, credits },
      );
    }
    if (args.legs.some((l) => l.amount <= 0)) {
      throw new DomainError(
        ErrorCode.LEDGER_IMBALANCE,
        'ledger amounts must be positive; use direction to express sign',
      );
    }

    const txnId = ulid();
    await tx.insert(ledgerTransactions).values({
      id: txnId,
      kind: args.kind,
      bookingId: args.bookingId ?? null,
      description: args.description ?? null,
      idempotencyKey: args.idempotencyKey ?? null,
    });

    for (const leg of args.legs) {
      const accountId = await this.accountId(tx, leg.account.type, leg.account.ownerId);
      await tx.insert(ledgerEntries).values({
        id: ulid(),
        txnId,
        accountId,
        bookingId: args.bookingId ?? null,
        direction: leg.direction,
        amountPaise: leg.amount,
        type: leg.type,
        meta: leg.meta ?? {},
      });
    }
    return txnId;
  }

  /** Derived balance. There is no stored balance column anywhere, by design. */
  async balance(type: LedgerAccountType, ownerId?: string | null): Promise<number> {
    const rows = await this.db
      .select({
        balance: sql<string>`
          COALESCE(SUM(CASE WHEN ${ledgerEntries.direction} = 'credit'
                            THEN ${ledgerEntries.amountPaise} ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ${ledgerEntries.direction} = 'debit'
                            THEN ${ledgerEntries.amountPaise} ELSE 0 END), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .where(and(
        eq(ledgerAccounts.ownerType, type),
        ownerId == null
          ? sql`${ledgerAccounts.ownerId} IS NULL`
          : eq(ledgerAccounts.ownerId, ownerId),
      ));
    return Number(rows[0]?.balance ?? 0);
  }

  /**
   * Open cash dues for a purohit. Under the corrected model these arise ONLY from
   * exceptions (waived-token promos, adjustments) - not from every cash booking.
   * See ADR 0004 and the review's section 1.1.
   */
  async openDues(panditId: string): Promise<number> {
    const rows = await this.db
      .select({
        dues: sql<string>`
          COALESCE(SUM(CASE WHEN ${ledgerEntries.type} = 'cash_due'
                            THEN ${ledgerEntries.amountPaise} ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN ${ledgerEntries.type} = 'cash_recovery'
                            THEN ${ledgerEntries.amountPaise} ELSE 0 END), 0)`,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerEntries.accountId, ledgerAccounts.id))
      .where(and(
        eq(ledgerAccounts.ownerType, 'pandit'),
        eq(ledgerAccounts.ownerId, panditId),
      ));
    return Number(rows[0]?.dues ?? 0);
  }
}
