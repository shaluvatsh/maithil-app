# Architecture

The system as built. Current state, not intent — where something is unfinished it is
listed under [Known gaps](#known-gaps) rather than described as if it works.

For *why* a decision was made, see `docs/adr/`. For how to work on the code, see
`CONTRIBUTING.md`.

---

## Shape

```
                    ┌── Next.js (Fly, 1 machine) ──┐   5 of 13 pages server-rendered
   browser ────────►│  no CDN                      │   the rest fetch on the client
                    └──────────────┬───────────────┘
                                   │ JSON
                    ┌──────────────▼───────────────┐
                    │  NestJS modular monolith     │  ← outbox relay and panchang job
                    │  one process                 │    run INSIDE this process
                    └───┬──────────┬───────────┬───┘
                        │          │           │
                  Postgres      Redis      Razorpay / WhatsApp BSP
                 (single region, no replica)
```

**Modular monolith, deliberately.** At this volume microservices would buy
distributed-systems problems and no benefit. Module boundaries are structural, so
extracting one later is a build change rather than a rewrite. See ADR 0001.

**Two workspace packages carry all shared meaning.** `packages/region` answers "what is
a city" (slots, panjikas, currency, numerals, coordinates); `packages/contracts` holds
the booking state machine, pricing, refund rules and the `Paise` branded type. The API,
the web app and any future mobile client read the same source. Anything that varies by
city, ritual or tradition is data in these packages, never a branch in a service.

---

## The parts that carry money

These are the load-bearing pieces. They are correct, constrained at the database level,
and covered by integration tests that run against a real Postgres engine.

**Double-entry ledger.** No stored balances anywhere — `debits == credits` is enforced
by a deferred constraint trigger that fires at COMMIT, plus append-only triggers. An
application bug cannot corrupt the books. `Paise` is a branded type, so passing a raw
`number` across a module boundary is a compile error.

**The platform fee is charged to the devotee, on top of dakshina.** This is what makes
cash bookings safe. The token — paid online at confirmation in *every* payment mode
without exception — equals the platform fee. The purohit collects
`dakshina + samagri + travel` in cash and is never asked to remit anything, so
commission cannot leak. A normal cash booking creates no ledger due at all.

**Booking state machine.** A declarative transition table in `packages/contracts` is the
only place a valid move is defined. `transition()` takes `FOR UPDATE`, re-reads the
locked state and verifies it before writing, so two concurrent transitions cannot both
succeed. The state change, its audit row and its outbox event commit together.

**Slot concurrency.** A Redis soft hold for UX, then `FOR UPDATE` over an ordered
contiguous span at confirm time, with a unique index as the backstop. Correctness comes
from the lock, not the hold — tested with the hold removed.

**Transactional outbox.** Domain events commit in the same transaction as the state
change they describe, then a relay publishes them. This is why a crash cannot leave a
confirmed booking with no downstream effect. The relay claims, publishes and marks in
one transaction, so a second instance cannot republish a batch mid-flight.

**Exactly-once payment capture.** A unique `(provider, provider_event_id)` claim on
webhook events, HMAC signature verification, and an amount check across all three
numbers that must agree (the gateway payload, the stored intent, the booking price).

**Panchang computed in-house.** Bisuddha Siddhanta is the drik (observed) school, so it
is derived from solar and lunar positions with the Lahiri ayanamsa — no vendor, no
licence, no lead time (`domain/astronomy.ts`). Gupta Press applies Surya Siddhanta with
the press's own corrections and cannot be reproduced, so it stays hand-entered once a
year. Where the two schools disagree the UI says so rather than picking a winner; in
2005 they published different dates for Durga Puja. See ADR 0003 — the most
consequential decision in the design.

Intervals are stored with a GiST exclusion constraint, so overlapping tithis are
impossible at the schema level. The materialisation job takes a Postgres advisory lock
on a reserved connection, so a second instance skips the run instead of racing the
constraint.

---

## The read path

This is the weaker half, and the gap is strategic rather than technical.

**Caching exists but is partial.** `/v1/rituals`, `/v1/categories`, `/v1/offers/current`,
`/v1/stats` and the panchang routes carry `Cache-Control` via the `@Cacheable`
decorator. Search and availability deliberately do not — they return live slot state
that changes on every booking.

**Server rendering is partial.** Five of thirteen pages are server components:
`/pooja/[slug]` (with `generateStaticParams` and `revalidate`), `/services`, `/privacy`,
`/contact`, `/terms`. Eight remain client-only — including the home page, `/panchang`,
and the booking flow.

The booking flow *should* stay client-rendered; it is an interactive form and nobody
needs to crawl it. The home page and the almanac are a different matter: every
competitor in this category is a content and SEO business wearing a marketplace skin,
with per-city and per-ritual landing pages going back years. That is how the category
acquires demand. A pan-India marketplace Google cannot read has no organic acquisition
channel, which costs more than any latency item on this page.

---

## Data model notes

One schema file per bounded context in `apps/api/src/db/schema/`. Migrations are
hand-run `.sql` files applied in filename order by `db/migrate.ts` and tracked in a
`_migrations` table — `0000_init.sql` is generated, `9999_guards.sql` is hand-written
and holds the triggers the ledger invariant depends on.

Seven tables are append-only and grow without bound: `outbox`, `audit_log`,
`notifications`, `processed_events`, `webhook_events`, `idempotency_keys` and
`ledger_entries`. `availability` grows with purohit count × horizon (500 purohits ≈ 240k
rows; 50,000 ≈ 24M). Neither pruning nor partitioning is in place — see Known gaps.

---

## Testing

```
pnpm typecheck && pnpm build && pnpm test
```

899 tests across 57 files. The API integration suites boot Postgres compiled to
WebAssembly in-process, so CI needs no database service and still exercises the real
triggers, exclusion constraints and transaction semantics. The web suite runs jsdom
under Vitest, including a CSS invariant test that fails the build when a JSX
`className` has no matching rule.

Tests catch structure, not appearance. Layout, spacing and reachability on a phone are
verified by driving the real app — see `scripts/e2e/`.

---

## Known gaps

Ordered by when they start costing something. Each is a real finding against the code,
not a hypothetical.

### Before a second instance

| Gap | Why it matters |
|---|---|
| `REDIS_URL` is optional; the code falls back to `MemoryKv` | Rate limits become per-instance. "5 OTP sends per hour" across 10 instances is really 50, on exactly the endpoints whose security model depends on the limit being real. Make it required in production. |
| Connection pool `max: 10` per instance, undocumented ceiling | Postgres defaults to `max_connections = 100`. Ten instances sit exactly at the ceiling. Size it deliberately or add PgBouncer. |

### Correctness, open

| Gap | Where |
|---|---|
| `register()` attaches a password to an existing OTP-only account matched only by phone, with no ownership proof, and returns live tokens | `auth.service.ts` — account takeover from a known phone number. Highest-severity open item. |
| `users.email` has no unique constraint (only `phone` does) | Concurrent registration can create two accounts sharing one email; password login then picks one arbitrarily. |
| Refresh tokens live 30 days with no revocation | No `jti`, no `token_version`. Sign-out-everywhere and password change cannot invalidate a live token. |
| Purohit-cancel rematch can throw instead of falling back | `booking.service.ts` `rematch()` — if the replacement's slot is taken between match and lock, `SLOT_UNAVAILABLE` aborts the whole cancellation rather than falling through to refund as documented. |
| `rematch()`'s purohit swap has no row lock or CAS guard | Unlike every state transition, the `panditId` UPDATE is unguarded; concurrent cancels can clobber each other and leave event history inconsistent. |
| Panchang day-bucketing compares a UTC date slice to an IST date | `panchang.service.ts` — intervals starting between 18:30 and 24:00 IST land on the wrong day in the purohit's transition-time view. |
| Re-seeding never updates existing BOM line items | `db/seed/index.ts` skips items whenever a BOM row exists, so an environment seeded before a kit change keeps the old materials cost forever. |

### Multi-city readiness

The region package models per-city slots correctly, but three call sites still assume
Kolkata's four-slot day, and one assumes its timezone:

| Gap | Where |
|---|---|
| Search rejects `slotIdx > 3` | `search.controller.ts` — the southern cities have five slots, so their evening slot is unsearchable. |
| Booking creation hardcodes `slotIdx + slotSpan > 4` | `booking.service.ts` — same five-slot cities, rejected at creation. |
| `slotInstant()`'s `citySlug` parameter is never passed by any caller | Every booking and availability row is timestamped against Kolkata's UTC offset. |
| Purohit and admin screens use a hardcoded English slot-label array and a hardcoded `₹`/`en-IN` formatter | `web/lib/format.ts` — other cities' jobs are labelled with Kolkata's times; a five-slot city renders blank. |
| `PATCH /me/panjika` validates three schools; the contract and DB enum define six | `booking-read.controller.ts` — devotees outside Bengal/Mithila cannot set their own panjika. |

### Performance, sequenced behind the SEO work

| Gap | Projection |
|---|---|
| No usable geo index — `pandit_geo_idx` is a btree on `(base_lat, base_lng)`, which cannot serve a radius query, so every search runs haversine over every matching row | On the hot path: every search *and* every auto-assignment at booking creation. Fix with a bounding-box prefilter or PostGIS + GiST. |
| Ledger balance is an aggregate scan | Fine per purohit; the platform account accumulates every entry ever written, so platform balance degrades linearly forever. Needs nightly snapshots. |
| `availability` unpartitioned, seven append-only tables unpruned | See Data model notes. `idempotency_keys` already has `expires_at` and nothing deletes them. |
| Home page and `/panchang` are client-rendered | The two best organic-acquisition surfaces are unindexable. |

### Missing operationally

No error tracking (Sentry is named in ADR 0007 and not wired), no APM, no structured log
aggregation, and no request tracing beyond a request id. Nothing reports a production
error today.

---

## Capacity

Assumes two API calls per page view, which is what the client-rendered pages actually do.

| Scale | Page views/day | Sustained rps | Verdict |
|---|---|---|---|
| Pilot | ~2,000 | <1 | Comfortable on one 512 MB machine |
| Early traction | 50,000 | ~1.2 avg, ~12 peak | Fine, provided Postgres is not scale-to-zero |
| Growth | 500,000 | ~12 avg, ~120 peak | Breaks — Postgres saturates on repeated catalogue queries. Needs caching and static pages first |
| Scale | 5,000,000 | ~120 avg, ~1,200 peak | Needs CDN-first static pages, read replica, PgBouncer, jobs on their own worker |

Caching and static generation buy the first two orders of magnitude for very little
work. Read replicas and sharding are irrelevant until long after that.

**Deliberately not now:** microservices, sharding, event sourcing, multi-region,
Kubernetes, GraphQL, a second datastore. None solves a problem this system has.

---

## Stack

| Choice | Verdict |
|---|---|
| NestJS | Sound. Heavier than one engineer needs, but DI and module structure earn their keep as the team grows |
| Drizzle over Prisma | Vindicated. `FOR UPDATE`, deferred triggers and CTEs are first-class; Prisma would have forced `$queryRaw` exactly where type safety matters most (ADR 0002) |
| Postgres for everything | Right. Ledger, slots, panchang intervals and search all fit. Resist a second datastore until Postgres hurts |
| Redis | Correct scope — holds and rate limits only, never correctness |
| Next.js | Right framework, under-used. App Router as a client-side SPA discards its main advantage |
| Razorpay Route | Right for India. Escrow hold duration is still an open question — see `PRODUCTION.md` |
| In-house astronomy | Good call. Removed a vendor from the critical path; accuracy limits documented and pinned by tests |
| Fly.io single region (`bom`) | Right for now. In-country matters for DPDP comfort and gateway latency |
