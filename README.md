# The Maithil

Two-sided marketplace connecting verified purohits with devotees for Hindu rituals.
**Launch city: Kolkata.** Bengali-first.

This repository implements the *revised* architecture — see `docs/adr/` for what changed
from the original handoff and why. The short version:

| Change | ADR |
|---|---|
| Panchang is dual-school (Bisuddha Siddhanta + Gupta Press) and stored as intervals | [0003](docs/adr/0003-panchang-dual-school.md) |
| Cash bookings withhold TDS correctly; dues are exceptional, not routine | [0004](docs/adr/0004-money-and-ledger.md) |
| Domain events go through a transactional outbox | [0005](docs/adr/0005-transactional-outbox.md) |
| Bookings occupy a contiguous slot *span*, with absolute timestamps | [0006](docs/adr/0006-slot-model.md) |
| Free-tier hosting; AWS deferred until it hurts | [0007](docs/adr/0007-hosting.md) |
| R1 scope cut for a 1–2 engineer team | [0008](docs/adr/0008-r1-scope.md) |

## Quick start

```bash
pnpm install
docker compose up -d              # Postgres 16 + Redis 7
cp .env.example .env
pnpm db:migrate
pnpm db:seed                      # 25 Kolkata rituals, BOMs, panchang terms
pnpm dev
```

```bash
pnpm typecheck    # tsc across the workspace
pnpm test         # 89 tests; the integration suites run a real Postgres engine
```

No Docker needed for tests. The integration suites boot Postgres 18 compiled to
WebAssembly in-process, so they exercise the same triggers, exclusion constraints and
transaction semantics production relies on.

## Layout

```
apps/api
  src/domain/             pure domain logic: pricing, settlement, slots, panchang, ledger
  src/modules/            auth, catalog, availability, booking — services + controllers
  src/common/             config, kv, idempotency, audit, error mapping
  src/workers/            outbox relay
  src/db/schema/          Drizzle schema, one file per bounded context
  src/db/migrations/      0000_init.sql (generated) + 9999_guards.sql (hand-written)
  src/db/seed/            Kolkata catalogue
  src/test/harness.ts     full stack over Postgres-in-wasm
packages/contracts        zod schemas, money type, state machine — the shared truth
docs/adr/                 architecture decision records
```

## The three things to understand first

**1. Money is paise, and balances are derived.**
`Paise` is a branded type, so passing a raw `number` across a module boundary is a
compile error. There is no `credits_paise` column and no stored balance anywhere —
the ledger is the only source of truth, and `debits == credits` is enforced by a
deferred constraint trigger that runs at COMMIT.

**2. The platform fee is charged to the devotee, on top of dakshina.**
This is what makes cash safe. The token — paid online at confirmation in *every*
payment mode, without exception — equals the platform fee. The purohit collects
`dakshina + samagri + travel` in cash and is never asked to remit anything, so
commission cannot leak. A normal cash booking creates no ledger due at all.

**3. Kolkata has two panjikas and they disagree.**
Bisuddha Siddhanta and Gupta Press publish different dates for the same festival —
in 2005 Durga Puja fell on two different sets of days. `school` is a column on every
panchang table, the devotee picks theirs at signup, and where the two disagree the UI
says so rather than picking a winner. See ADR 0003; this is the single most
consequential decision in the R1 design.

## Status

**Working end to end**: phone-OTP auth with JWT · localised catalogue · availability
materialisation and slot toggles · the full booking lifecycle (draft → hold → submit →
accept → confirm → start → complete) with slot locking, double-entry settlement,
refunds and the transactional outbox · idempotent completion · REST controllers.

**Not yet built**: Razorpay client and webhook handler (the confirm path is driven by
`confirmOnTokenCapture`, which the webhook will call) · panchang provider client and
nightly materialisation · WhatsApp/SMS delivery · search and matching · payouts ·
the three client apps.

### One bug worth knowing about

The integration suite caught a real one during development: the failed-OTP counter was
being incremented *inside* the transaction that then threw, so the rollback discarded it
and a 6-digit code could be brute-forced without limit. OTP verification now happens
before the transaction opens and the counter commits on its own connection. The test
that catches it is `rejects a wrong OTP and counts the attempt`.
