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
pnpm install                      # also builds the workspace packages
cp .env.example .env              # then point DATABASE_URL at your Postgres
docker compose up -d              # optional: Postgres 16 + Redis 7
pnpm db:migrate
pnpm db:seed                      # 25 Kolkata rituals, BOMs, panchang terms
pnpm db:seed:dev                  # demo purohits + a devotee, so there is something to book
pnpm dev                          # API on :3000, web on :3001
```

Open **http://localhost:3001**. Sign in as `9830012345` (devotee) or `9830000101`
(purohit) — the OTP is returned in the response while `OTP_DEV_BYPASS=true`, so there is
no SMS provider to set up.

No Redis needed locally: with `REDIS_URL` blank the code falls back to an in-memory
store. Redis only backs slot holds and OTP rate limits.

```bash
pnpm typecheck    # tsc across the workspace
pnpm test         # 160 tests; the integration suites run a real Postgres engine
```

No Docker needed for tests. The integration suites boot Postgres 18 compiled to
WebAssembly in-process, so they exercise the same triggers, exclusion constraints and
transaction semantics production relies on.

## Layout

```
apps/web                  Next.js — devotee, purohit and admin surfaces
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
panchang table, the devotee picks theirs, and where the two disagree the UI says so
rather than picking a winner. See ADR 0003; this is the single most consequential
decision in the R1 design.

Bisuddha Siddhanta is the drik (observed) school, so it is **computed in-house** from
solar and lunar positions with the Lahiri ayanamsa — no vendor, no licence, no lead
time (`domain/astronomy.ts`). Gupta Press applies Surya Siddhanta with the press's own
corrections and cannot be reproduced, so it stays hand-entered once a year. Measured
accuracy and its limits are documented in the astronomy module and pinned by tests.

## Status

**Working end to end**, API and UI: phone-OTP auth · localised Bengali catalogue ·
purohit search with Bayesian rating, haversine proximity and a cold-start boost ·
availability with travel buffers · the full booking lifecycle (draft → hold → submit →
accept → confirm → start → complete) with slot locking, double-entry settlement and
refunds · the transactional outbox · idempotent completion · a three-surface web app.

Also built: **Razorpay Route** (orders, HMAC-verified webhooks, exactly-once capture,
refunds) · **notifications** from the outbox with WhatsApp→SMS fallback · **payouts**
with dues recovery and carried TDS · **panchang computed from astronomy**, no vendor ·
**reviews** (double-blind, feeding search rank) · **admin verification queue** ·
security headers, rate limiting, request IDs, graceful shutdown · Docker, Fly and CI.

**Not yet built**: the two mobile apps · samagri partner kits · e-puja · subscriptions
and referrals · GST invoice PDFs.

**Read [`docs/PRODUCTION.md`](docs/PRODUCTION.md) before taking real money** — four
things block go-live, and two of them are legal rather than technical.

### One bug worth knowing about

The integration suite caught a real one during development: the failed-OTP counter was
being incremented *inside* the transaction that then threw, so the rollback discarded it
and a 6-digit code could be brute-forced without limit. OTP verification now happens
before the transaction opens and the counter commits on its own connection. The test
that catches it is `rejects a wrong OTP and counts the attempt`.

## Troubleshooting

**Blank page / 500 on the web app, `Module not found: Can't resolve '@themaithil/region'`.**
The workspace libraries compile to `dist/`, which is gitignored. `pnpm install` rebuilds
them via each package's `prepare` script, and `pnpm dev` builds them first through turbo —
so this should not recur. If you hit it after pulling, run `pnpm install` once.

**`next: command not found`.** A new app or package was added and its dependencies are
not installed. `pnpm install`.

**Ports.** API on 3000, web on 3001. `lsof -ti :3000 | xargs kill` if one is stuck.
