# Architecture review — HLD and LLD

Independent review of the system as built, 8 August 2026. Findings are grounded in the
actual code, not the intent.

---

## Follow-up pass — 22 August 2026

A second pass, prompted by "prioritise the issues and fix it." Two kinds of finding got
fixed: the S1 item this document already called the single most severe issue, and a set
of correctness bugs a full code read turned up that this HLD/LLD document never covered
(it reviews shape and scale, not line-by-line correctness). Verified with a fresh
`pnpm typecheck && pnpm build && pnpm test` after every change, per the repo's standing
verification rule, plus new tests for anything that had none.

**Fixed:**
- **S1 #1 — panchang job leader election.** `PanchangJob` now takes an optional
  `LeaderLock`; `main.ts` wires a real `PgAdvisoryLock` (`pg_try_advisory_lock` on a
  reserved connection, so acquire/release are provably the same session under
  connection pooling). A second instance now skips the run instead of racing the GiST
  exclusion constraint. See `workers/leader-lock.ts`.
- **Outbox relay was not actually concurrency-safe**, contrary to both its own comment
  and this document's HLD claim ("SKIP LOCKED makes concurrent relays safe by design").
  The claiming transaction committed before publishing, releasing every row lock first —
  a second instance could claim and republish the same batch. Claim, publish and mark are
  now one transaction.
- **Notification delivery was at-most-once, not at-least-once as documented.** The
  consumer-side dedupe claim was written *before* the send; a crash or any thrown error
  between the two left the event marked "processed" with nothing actually delivered,
  permanently. It now un-claims on failure so the next delivery retries.
- **Booking state machine had an unchecked compare-and-set.** Two concurrent transitions
  on the same booking could see the second's UPDATE match zero rows while the audit
  insert and outbox emit ran anyway — a domain event asserting a transition that never
  happened. `transition()` now takes `FOR UPDATE` and verifies the real state before
  writing anything.
- **Idempotency keys were unique across all users, not per user** — two different users
  submitting the same client-generated key collided. Now `(user_id, key)`.
- **A failed idempotent request stayed stuck "in progress" for 24h**, including the
  client's own legitimate retry after a transient failure — the single most likely case
  for `/complete`, which sits on the offline-sync path. The claim now clears on failure.
- **The payment webhook never compared the captured amount to the order amount.** Three
  numbers had to agree (Razorpay's payload, the stored intent, the booking price) and
  nothing checked any two of them against each other.
- **Rate limiting trusted `X-Forwarded-For` directly**, with no `trust proxy` set —
  `X-Forwarded-For: <random>` reset every counter for free, on exactly the endpoints
  (OTP send, login) whose security model depends on the limit being real. Now reads
  Fly's edge-set `Fly-Client-IP`, which a client cannot forge.
- **Purohit matching ignored `slotSpan`** — a multi-slot ritual could be assigned to a
  purohit free for only the first slot, failing at booking confirmation after the
  devotee had already committed. The match query now checks every slot in the span.
- **Every notification used the launch city's slot times and an unpredictable ritual
  translation**, for all 14 cities, regardless of the recipient's own locale — the exact
  bug this document's own `panchang.job.ts` already tells a story about, one file over
  and unfixed. Now resolved per booking and per recipient.
- **New addresses defaulted to `(0, 0)`** — the Atlantic — despite a comment promising
  the city centroid; the centroid was never actually wired in. Proximity, 25% of
  search's ranking weight, was computed against it for every self-registered devotee.
- **`addressId` on booking creation was not checked against the caller** — an IDOR
  letting any devotee book a ceremony to another household's saved address.
- **The anniversaries read model filtered "not a recent booking" in JS after `LIMIT 6`**
  on rows already ordered most-recent-first, so it filtered exactly the six rows least
  likely to survive the filter. Moved into `HAVING`, before the limit.
- **A weekly-pattern regeneration could silently close a slot the purohit had opened by
  hand outside their normal pattern** — the exact failure mode this file's own
  docstring warns against, just in the opposite direction (protected against a manual
  *close* being reopened; not against a manual *open* being closed). Pattern-driven
  writes now use the schema's already-defined but previously unused `'recurring'`
  source tag, distinct from `'manual'`, so the two are no longer indistinguishable.
- **`expireStaleAccepts` selected every `pending_accept` booking in the table** every
  minute, with the actual filter commented out ("kept simple"). Restored as a SQL
  predicate.
- **A Redis slot hold leaked for its full 10-minute TTL** on any failure after
  acquisition (pricing lookup, insert, etc.) in `createDraft`. Now released on any throw.
- **CORS blocked the apex domain in production** — `/\.themaithil\.in$/` requires a
  literal dot before the domain, present for any subdomain but not for
  `https://themaithil.in` itself, the address someone actually types.
- **`docker-compose.yml` was deleted while `README.md` and the root `db:up` script still
  referenced it**, and `apps/api/Dockerfile` did not exist despite being required by both
  `fly.toml` and the CI image-build step — the deploy pipeline and documented local setup
  were both broken. Both restored/added.
- **`apps/web` and `packages/region` were untracked in git** (`git ls-files` returned 0
  for both) while `pnpm-lock.yaml` lists `apps/web` as a workspace importer — a fresh
  clone with `pnpm install --frozen-lockfile`, CI's own first step, could not have
  reproduced this tree.
- **The web test suite silently never ran on Node ≥ 20.13**, including the 22 CI pins and
  the 26 this was developed on: Node's own experimental global `localStorage` shadows
  jsdom's inside this test environment (`window === globalThis` here), so every
  `localStorage.clear()` in a `beforeEach` threw before a single assertion ran. 225 of
  321 web tests were failing for a reason unrelated to any of them. Fixed with a real
  in-memory `Storage` polyfill, forced onto `globalThis` regardless of Node version.
- Registration's weak-password and duplicate-account responses returned `FORBIDDEN`
  (403) — indistinguishable from an auth failure on a client that switches on `code`, the
  entire point of the closed error-code set this API otherwise maintains. Now
  `WEAK_PASSWORD` (422) and `ACCOUNT_EXISTS` (409).
- `PATCH /me/panjika` took its body unvalidated, and its own (unenforced) TS type had
  quietly drifted from the schema — `panjika_school` has three values, not two, so a
  devotee wanting the Mithila panjika could not express that through this endpoint at
  all. Now zod-validated against all three.

**Corrected in this document:** the SEO section below said "12 of 13 pages are
`'use client'`." That was accurate on 8 August and is not now — `/pooja/[slug]`,
`/services`, `/privacy`, `/contact` and `/terms` are server components, three with
`generateStaticParams`/`revalidate` already wired. The gap is real but smaller than
stated; see the section below for what remains.

**Deliberately not done in this pass** (flagged rather than silently skipped):
- Refresh-token rotation/revocation (`users.token_version`) — still absent, needs a
  migration and a deliberate sign-out-everywhere design, not a drive-by fix.
- The concurrent-registration race (two requests for the same new email racing past the
  existence check into the same unique-constraint insert) still 500s instead of
  returning `ACCOUNT_EXISTS`. Needs the driver's actual unique-violation error shape
  handled deliberately, not guessed at.
- PostGIS / bounding-box prefilter for search proximity, `Cache-Control` on catalogue and
  panchang, `availability` partitioning, ledger balance snapshots, read replica, PgBouncer
  — all still open, and still correctly sequenced behind the SEO and caching work below,
  which returns more per hour of work at current scale.

---

## Verdict

**The transactional core is genuinely well built. The read path is not built at all.**

Money movement, slot concurrency, settlement and payment capture are correct, constrained
at the database level and well covered. That is the hard half and it is done properly.

But the system is shaped for a product that takes 11 bookings a day, and you are asking
whether it handles a large number of users. Those are different problems, and the second
one has barely been designed for. Specifically:

| | State |
|---|---|
| Write path (bookings, money) | **Strong.** Correct under concurrency, tested against a real engine |
| Read path (browse, search, panchang) | **Weak.** No caching, no CDN, no server rendering, no usable geo index |
| Horizontal scaling | **Broken today.** A second instance corrupts the panchang job and multiplies rate limits |
| Data growth | **Unmanaged.** Seven append-only tables with no pruning, no partitioning |
| SEO | **Absent.** 12 of 13 pages are client components. A marketplace that cannot be crawled cannot acquire users |

**One-line answer: it will comfortably serve the pilot, it will fall over the day you run
two instances, and it cannot acquire users at scale because Google cannot read it.**

---

## HLD — topology

```
                    ┌── Next.js (Fly, 1 machine) ──┐   all client-rendered
   browser ────────►│  no CDN, no ISR, no SSG      │   fetches API on every view
                    └──────────────┬───────────────┘
                                   │ JSON
                    ┌──────────────▼───────────────┐
                    │  NestJS modular monolith     │  ← outbox relay AND panchang job
                    │  12 modules, 1 process       │    run INSIDE this process
                    └───┬──────────┬───────────┬───┘
                        │          │           │
                  Postgres      Redis      Razorpay / BSP
                 (single, 1 region, no replica)
```

### What is right

**The modular monolith was the correct call** and remains so. At this volume,
microservices would have bought distributed-systems problems and no benefit. Module
boundaries are enforced by structure, so extraction later is a build change.

**The transactional outbox is the single best decision in the codebase.** Domain events
commit with the state change they describe. It is the reason a crash cannot leave a
confirmed booking with no downstream effect.

**Region config as data** means pan-India expansion is a config file, and the same package
serves API, web and eventually mobile.

### What breaks, and when

**1. Horizontal scaling is broken today — this is the most serious finding.**

`main.ts` starts both the outbox relay and the panchang job with `setInterval` inside the
API process. There is **no leader election and no advisory lock**.

The outbox relay is fine — `SKIP LOCKED` makes concurrent relays safe by design. **The
panchang job is not.** It does `DELETE` then bulk `INSERT` over the same date window, and
`panchang_intervals` carries a GiST exclusion constraint forbidding overlaps. Two
instances running it concurrently will deadlock or violate the constraint, and in the
window between delete and insert the panchang tab serves nothing.

The moment you add a second machine — for availability, not even for load — this breaks.

**2. Rate limiting silently degrades to per-instance.** `RedisKv` is only used when
`REDIS_URL` is set; otherwise `MemoryKv`. With Redis unset and 10 instances, your
"5 OTP sends per hour" is really 50, and the OTP brute-force protection is 10× weaker
than intended.

**3. Single region, single Postgres, no read replica.** Every catalogue browse, panchang
view and search hits the primary. There is no read/write split to add later without
touching the data layer.

---

## LLD — findings by severity

### S1 · Breaks correctness or operations

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 | **Panchang job has no leader election** | `workers/panchang.job.ts` `setInterval`, started in every instance | `pg_try_advisory_lock` around `runOnce()`, or move jobs to a dedicated worker process with `min_machines = 1` |
| 2 | **Rate limiter is per-instance without Redis** | `app.module.ts` falls back to `MemoryKv` | Make `REDIS_URL` **required** in production, same as the Razorpay guard |
| 3 | **Connection pool will exhaust Postgres** | `max: 10` per instance; Postgres default `max_connections` 100 | 10 instances = 100 connections = at the ceiling. Add PgBouncer, or set `max: 5` and size deliberately |

### S2 · Performance cliffs

| # | Finding | Measured | Fix |
|---|---|---|---|
| 4 | **Panchang materialisation is 3,120 sequential inserts per city per run** — 43,680 across 14 cities, ~44s of round-trips, every 6 hours, on every instance | counted from `panchang.service.ts` | Batch the muhurat flags into multi-row inserts. Drops to ~30 statements per city |
| 5 | **No usable geo index.** `pandit_geo_idx` is a btree on `(base_lat, base_lng)` — a btree cannot serve a radius query, so every search computes haversine over every matching row | `0000_init.sql` | PostGIS `geography` column + GiST index, or a cheap bounding-box prefilter before the trig |
| 6 | **No HTTP caching anywhere.** Catalogue and panchang are recomputed per visitor | zero `Cache-Control` in the API | `Cache-Control: public, s-maxage=3600, stale-while-revalidate` on `/v1/rituals` and `/v1/panchang`. Both change at most daily |
| 7 | **12 of 13 pages are client components**, zero `revalidate` / `generateStaticParams` | grep | See the SEO section — this is the biggest strategic gap |
| 8 | **Ledger balance is an aggregate scan.** Fine per purohit; the **platform** account accumulates every entry ever written, so platform balance degrades linearly forever | `domain/ledger.ts` | Nightly balance snapshot per account; query = snapshot + entries since |

### S3 · Growth and data management

| # | Finding | Projection | Fix |
|---|---|---|---|
| 9 | **`availability` grows unbounded and is unpartitioned** | 500 purohits = 240k rows · 5,000 = 2.4M · 50,000 = **24M** | Partition by month on `date`; drop partitions older than 90 days |
| 10 | **Seven append-only tables with no pruning** — `outbox`, `audit_log`, `notifications`, `processed_events`, `webhook_events`, `idempotency_keys`, plus `ledger_entries` | `outbox` alone: ~5 events/booking, forever | Retention job. `idempotency_keys` already has `expires_at` and nothing deletes them |
| 11 | **Refresh tokens live 30 days with no revocation** | no `jti`, no version column | `users.token_version`, bumped on sign-out-everywhere and password change |

### What is genuinely good

Worth stating, because a review that only lists faults misleads:

- **Ledger invariant enforced by a deferred constraint trigger** at COMMIT, plus
  append-only triggers. Application bugs cannot corrupt the books.
- **Slot concurrency**: Redis soft hold, `FOR UPDATE` over an ordered contiguous span,
  unique index as backstop. Tested with the hold removed.
- **Exactly-once webhooks** via a unique `(provider, provider_event_id)` claim.
- **Idempotency on completion and cancellation**, not just payments.
- **Panchang stored as intervals with a GiST exclusion constraint** — the schema makes
  overlapping tithis impossible.
- **~250 tests**, integration suites against a real Postgres engine in CI with no service
  container.

---

## The biggest gap is not performance. It is SEO.

**As of 8 August, 12 of 13 pages were `'use client'` with no static generation, no ISR,
no server data fetching. As of the 22 August follow-up pass, 5 of 13 are server
components** — `/pooja/[slug]` (with `generateStaticParams` and `revalidate`),
`/services` (`revalidate`), `/privacy`, `/contact`, `/terms` — **and 8 remain client-only,
including the home page, search and the panchang tab.** Real progress, but the pages that
matter most for organic discovery — the catalogue and the almanac, the actual demand
generators in this category — are still in the unindexable 8.

Every competitor in the category is a **content and SEO business** wearing a marketplace
skin. 99Pandit has ~95 city landing pages. Utsav publishes panchang for 30 cities plus
hundreds of aarti and chalisa pages. SmartPuja has per-city and per-ritual pages going
back to 2016. That is how the entire category acquires demand.

A pan-India marketplace that cannot be crawled has no organic acquisition channel at all.
This costs more than any latency problem on this list.

**The fix is architectural, not cosmetic:**

- `/[city]/[ritual]` as **server components with `generateStaticParams`** — 14 cities ×
  25 rituals = 350 statically generated pages, revalidated daily
- Panchang pages per city per month, ISR with a 24-hour window
- Keep the interactive booking flow as client components; it does not need to be indexed
- Add `sitemap.xml`, `robots.txt`, JSON-LD `Service` and `LocalBusiness` schema

This also fixes finding 7 — statically generated pages are served from the CDN and never
touch the API.

---

## Capacity model — what breaks at what scale

Assumes 2 API calls per page view (catalogue + panchang), which is what the current
client-rendered pages actually do.

| Scale | Page views/day | Sustained rps | Verdict |
|---|---|---|---|
| Pilot (target) | ~2,000 | <1 | Comfortable on one 512 MB machine |
| Early traction | 50,000 | ~1.2 avg, ~12 peak | Fine, **provided Postgres is not scale-to-zero** |
| Growth | 500,000 | ~12 avg, ~120 peak | **Breaks.** Postgres CPU saturates on repeated catalogue queries. Needs caching + static pages first |
| Scale | 5,000,000 | ~120 avg, ~1,200 peak | Needs CDN-first static pages, read replica, PgBouncer, jobs on their own worker |

The honest read: **caching and static generation buy you the first two orders of
magnitude for almost no work.** Read replicas and sharding are irrelevant until long after
that. Do not build them now.

---

## Tech stack assessment

| Choice | Verdict |
|---|---|
| **NestJS** | Sound. Heavier than needed for one engineer, but the DI and module structure earn their keep as the team grows |
| **Drizzle over Prisma** | Correct, and vindicated. `FOR UPDATE`, deferred triggers and CTEs are all first-class. Prisma would have forced `$queryRaw` exactly where type safety matters most |
| **Postgres for everything** | Right. Ledger, slots, panchang intervals and search all fit. Resist adding a second datastore until Postgres actually hurts |
| **Redis** | Correct scope — holds and rate limits only, never correctness |
| **Next.js** | Right framework, **wrong usage.** Using App Router as a client-side SPA discards its main advantage |
| **Razorpay Route** | Right for India. Escrow hold duration is still the open question |
| **In-house astronomy** | Good call. Removed a vendor from the critical path. Accuracy limits are documented and tested |
| **Fly.io single region (`bom`)** | Right for now. In-country matters for DPDP comfort and Razorpay latency |
| **Missing: CDN, APM, error tracking, structured log aggregation** | Sentry is listed in ADR 0007 and not wired. There is no request tracing beyond a request id |

---

## Prioritised remediation

**Before a second instance** (hours of work, prevents corruption):
1. ~~Advisory lock on the panchang job, or move jobs to a dedicated worker~~ **Done —
   22 August 2026, see the follow-up pass above.**
2. Make `REDIS_URL` required in production
3. Set pool `max` deliberately and document the instance ceiling

**Before real traffic** (days, buys two orders of magnitude):
4. `Cache-Control` on catalogue and panchang endpoints
5. Batch the panchang muhurat inserts
6. Static `/[city]/[ritual]` pages with ISR, plus sitemap and JSON-LD
7. Bounding-box prefilter on search, or PostGIS

**Before 10k purohits** (weeks):
8. Partition `availability` by month, retention on the append-only tables
9. Ledger balance snapshots
10. Read replica for the browse path
11. Token revocation

**Deliberately NOT now:** microservices, sharding, event sourcing, multi-region,
Kubernetes, GraphQL, a second datastore. None of these solve a problem you have, and each
costs a solo team more than it returns.

---

## The uncomfortable summary

The engineering is better than the product needs today and worse than the product needs at
scale — but in an unusual direction. Most early systems have a sloppy ledger and a fast
website. This one has a **rigorous ledger and an unindexable website**.

If the goal is a pilot in Kolkata, ship it. If the goal is pan-India user acquisition, the
static-generation and SEO work is not an optimisation — it is the product's only
acquisition channel, and it is currently absent.
