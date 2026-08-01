# ADR 0004 — Money representation and double-entry ledger

Status: Accepted · 31 Jul 2026

## Decision
- All money is `BIGINT` **paise**. No floats, anywhere, ever. The `Paise` branded type in
  `@themaithil/contracts` makes a raw `number` a compile error at module boundaries.
- Every movement writes a balanced set of rows against a `ledger_transactions` header.
- **Balances are always derived.** No mutable balance column exists on any table.
  This is why `users.credits_paise` from the original design is deleted — it was a second
  source of truth for the same number the ledger already holds.

## Invariant
For every `ledger_transactions.id`: `sum(amount_paise) FILTER (direction='debit')
= sum(amount_paise) FILTER (direction='credit')`.

Enforced in three places, deliberately redundant:
1. `LedgerService.post()` refuses to write an unbalanced transaction.
2. A `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks at COMMIT.
3. A CI test posts every transaction type and asserts the invariant.

## Cash treatment (corrects the original settlement algorithm)
On a cash booking the pandit's dakshina never passes through us, but s.194-O still deems us
the payer. So at completion we post a **notional credit** to the pandit and an immediate
offsetting `cash_settled_direct` debit. Net ledger effect is zero; the TDS base is now correct
and the pandit's earnings dashboard shows real totals rather than digital-only.
Withholding that cannot be taken from a cash booking becomes a `tds_carry` due against the
next digital payout.

Flagged for CA sign-off before P1-6. Also open: whether GST s.9(5) e-commerce-operator
liability applies given most purohits will be below the registration threshold.
