# Production readiness

Read this before taking a rupee from a real devotee.

The transactional core is production-grade: money movement, the booking state machine,
slot concurrency, payment capture and settlement are correct, constrained at the
database level, and covered by integration tests against a real Postgres engine.

The system is **not ready to serve real customers**, for reasons that are mostly not
about code quality.

**The shortest honest path to a first real booking** is now four items, in this order:

1. An email provider, so a forgotten password is recoverable (~an afternoon).
2. Somewhere to deploy the web app (there is no `apps/web/Dockerfile` and CI discards
   the frontend build).
3. A CA's signature on the cash tax treatment.
4. The consulting purohit's sign-off on the panchang.

Payments and WhatsApp are no longer on that path — see blockers 1 and 3 for why, and for
what each costs you while deferred.

**Verified 27 Oct 2026.** Several entries below were stale in both directions — work had
landed that the document still listed as missing, and one blocker turned out not to be a
blocker at all. Every claim that remains has been checked against the code or a running
instance; where something was measured, the measurement is quoted.

---

## Blocking — cannot go live

### 1. No payment credentials — now deferrable, with a revenue consequence

**`PAYMENTS_ENABLED=false` runs the product cash-only.** No token is charged, a booking
confirms the moment it is submitted, the devotee pays the purohit the full amount on the
day, and production boots without `RAZORPAY_*`. Start and completion codes are still
issued; nothing is written to the ledger, because nothing was paid. The confirmation uses
its own `confirmed_unpaid` trigger, so `booking_events` carries a permanent per-booking
record of which bookings were taken on trust.

**What it costs.** The platform fee lives INSIDE the token by design, so that the purohit
is never asked to remit anything and commission cannot leak. With no token there is no
fee: `planSettlement` releases commission only `if (price.tokenPaise > 0)`. **Every
booking in this mode earns the platform exactly nothing**, and no due is recorded against
it. Collecting in arrears is possible — `feeShortfallPaise` already feeds the dues
machinery — but it is a commercial decision about what purohits were told, not a config
change.

**A second consequence, worth a CA's attention.** On a cash booking the platform withholds
TDS against money it never held, and that carry "comes out of the next digital payout"
(`payouts.service.ts`). In cash-only mode there is never a digital payout, so the carry
accumulates with no recovery path — the platform funds the purohit's withholding out of
its own pocket. Below the s.194-O annual threshold this does not arise; at any scale it
does.

So the gateway is no longer what stops a launch. The escrow question below still is, the
moment you switch payments on.

### 1b. The escrow question is unresolved

Razorpay Route is implemented end to end — order creation, HMAC webhook verification,
exactly-once processing, refunds, held transfers. It has never touched Razorpay's
sandbox, because there is no merchant account yet.

Worse, the **maximum escrow hold duration is still an open question.** The booking model
holds the token from confirmation until the ritual is performed. RBI's Payment Aggregator
Directions require settlement to the merchant within T+1; Route's settlement-hold feature
is the mechanism, but its limits are not confirmed. This matters most for exactly the
bookings you want: a muhurat booked a month out, festival pre-booking, subscriptions.

**If holds turn out to be capped**, the design changes — token captured at confirmation,
balance charged at T-2 rather than on completion. That is a real change to
`BookingService` and the settlement planner. Resolve it before writing more payment code.

Also expect **7–14 day settlement holds on a new merchant account.** A promise of weekly
payouts plus instant payout will not be true in month one, and purohits will notice
immediately.

### 2. The cash tax treatment needs a CA's signature

`settlement.ts` implements what appears correct: because s.194-O deems the operator to
have made the payment even when the devotee pays the purohit directly, cash bookings post
a notional credit and an offsetting `cash_settled_direct` debit so the withholding base is
right, with un-takeable withholding carried to the next digital payout.

That is a considered reading, not professional advice. **Have a CA confirm it**, and at
the same time answer the bigger question: does **GST s.9(5)** e-commerce-operator
liability apply, given most purohits will be below the registration threshold? If it does,
the platform owes GST on the full service value, which changes unit economics materially
— not just the code.

### 3. WhatsApp templates are not approved — no longer blocks sign-in

The notification pipeline is built and tested, with SMS fallback. But WhatsApp will not
deliver operator-initiated messages outside a 24-hour window without a **BSP-approved
template**, and approval takes 1–2 weeks per batch. Templates are seeded in Bengali;
`provider_template_name` is null on all of them, and the channel fails loudly rather than
dropping messages silently.

**THIS DOCUMENT USED TO CALL THAT A SIGN-IN BLOCKER. IT IS NOT, AND HAS NOT BEEN SINCE
EMAIL AND PASSWORD LANDED.** The boot check refused to start without a BSP on the grounds
that "login codes go to the server log and nobody can sign in". The first half is true;
the second is false. Verified against a running instance with no provider configured at
all: `POST /v1/auth/register` creates an account and issues tokens with no OTP and no
message, and `POST /v1/auth/login` needs nothing but the database. Both tabs already exist
in the login UI.

What was actually broken was narrower and much cheaper to fix: the login screen opened on
the OTP tab unconditionally, so a deployment with no provider greeted every visitor with
the one door that could not open while email and password sat behind a tab nobody clicked.
The screen now asks `/v1/config` which doors work and falls back; the OTP tab is hidden
rather than disabled, because a disabled tab invites people to keep tapping something that
will never answer.

The boot check now requires a messaging provider **or** email — password sign-in always
works, so the door is never missing, but without one of the two a locked-out devotee could
never get back in. That turns a fortnight of Meta verification into an afternoon of DNS
records.

Until WhatsApp lands every notification falls through to SMS — which works, costs more, and
is a worse experience in a WhatsApp-first market. That is a quality gap now, not a gate.

**Still true, and worth naming:** booking start and completion codes are delivered over
this pipeline, and the account page says so. In cash-only mode they are shown on screen at
confirmation, so the flow works — but a devotee who closes that screen has no second copy,
because only the hashes are stored.

### 4. The panchang needs a purohit's sign-off

The computation is built and tested: Bisuddha Siddhanta is derived in-house from solar and
lunar positions, intervals are materialised by a job under an advisory lock, and the UI
renders both schools with disagreements shown rather than resolved.

What is missing is human validation. **Shipping wrong muhurat dates in Kolkata is worse
than shipping none**, and the accuracy limits documented in `domain/astronomy.ts` have not
been checked against a practising purohit's own almanac. Gupta Press remains hand-entered
annually and has no admin screen for that entry.

---

## Built and production-grade

| Area | State |
|---|---|
| Booking state machine | Declarative transition table, guards, `FOR UPDATE` compare-and-set, audit rows and outbox events in one transaction |
| Slot concurrency | Redis soft hold + `FOR UPDATE` over a contiguous span + unique index. Tested with the hold removed |
| Double-entry ledger | Append-only, deferred constraint trigger enforcing debits == credits at COMMIT |
| Settlement | Cash and digital, TDS on both, dues only from promo exceptions |
| Payments | Order creation, HMAC-verified webhooks, exactly-once via `webhook_events`, amount cross-check, refunds |
| Payouts | Gross − dues − carried TDS − instant fee, credit-limit enforcement |
| Notifications | Template rendering, per-recipient locale, channel fallback, at-least-once delivery with consumer-side dedupe |
| Panchang | Computed in-house, materialised under a Postgres advisory lock, GiST exclusion constraint against overlaps |
| Reviews | Double-blind, published on mutual submission or a 72-hour window, feeding search rank |
| Auth | Phone OTP, hashed and constant-time compared, rate limited on send *and* verify. Password reset by email: single-use HMAC token in Redis (never stored raw), 30-minute TTL, rate limited per address — including addresses with no account, so the limit itself cannot be used to tell which emails are registered |
| Idempotency | On completion, cancellation and payment, scoped per user; conflicting replays rejected |
| Admin | Verification queue with approve/reject, coverage heatmap, incident feed, ledger view |
| Hardening | Security headers, per-route rate limits, request IDs, graceful shutdown, liveness vs readiness |
| Deployment | Multi-stage Docker, non-root, healthcheck; Fly config in `bom`; CI with migrations as a release command |

---

## Not built

Roughly in the order worth building them.

1. ~~**The travel buffer never fires.**~~ **Fixed.** [ADR 0013](adr/0013-continuous-time-scheduling.md)
   replaced the slot model with continuous time, and `assertFeasible` now computes the
   gap from the haversine distance between consecutive addresses and the city's average
   speed, widened by a slack that scales with how precisely the address is geocoded.
   Enforced inside the confirmation transaction under a purohit-level advisory lock.
   ~~*Leftover:* `confirmOnTokenCapture` still declares a vestigial `travelMinutes`.~~
   **Deleted**, along with the two call sites that passed a hardcoded `25` into a body
   that never read it.
2. **Token revocation** — refresh tokens live 30 days with no `jti` or `token_version`,
   so sign-out-everywhere and password change cannot invalidate a live session.
3. ~~**Video links for virtual bookings.**~~ **Fixed.** The purohit sets `joinUrl` on the
   booking, `JoinLinkChaseJob` chases them when they have not, and the devotee's booking
   detail renders the link — and the recording afterwards, which is what a family booking
   from abroad for their parents is actually paying for.
4. **A purohit decline path** — the `pandit_decline` trigger exists in the state machine
   and is wired to no endpoint. A purohit who wants out of an auto-accepted job must use
   the full cancel flow and take a cancellation penalty.
5. **Samagri partner kits** — cut from R1 by ADR 0008. Option A (purohit brings) works.
6. **Mobile apps** — one responsive web app covers all three surfaces today. Months, not
   weeks.
7. **E-puja, subscriptions, referrals** — all cut from R1.
8. **GST invoice PDFs** — required by the PRD, not implemented.

---

## Built, but nothing runs it

These are not unwritten features. The code exists, is tested, and has no caller — which
is the more dangerous shape, because reading the codebase suggests the behaviour is
present.

**MOSTLY CLOSED.** `Scheduler` (`workers/scheduler.ts`) now exists and `main.ts` runs
`expire-accepts`, `publish-reviews`, `anniversary-nudge`, `join-link-chase`,
`series-codes` and `kyc-purge` under advisory locks. The table below is what is left.

| What | State | Consequence |
|---|---|---|
| ~~`expireStaleAccepts()`~~ | **Fixed.** Runs as `expire-accepts` | — |
| ~~KYC image purge~~ | **Fixed.** `KycPurgeJob` runs as `kyc-purge` | The DPDP exposure this document described — holding Aadhaar and PAN photographs indefinitely while telling purohits otherwise — is closed |
| `PayoutService.run()` | Only an admin endpoint, triggered by hand | "Payouts run weekly" is on the purohit dashboard. Nothing makes that true. **Moot while `PAYMENTS_ENABLED=false`**: on a cash booking the purohit already holds the money (`cash_settled_direct` cancels the notional credit), so gross payable is zero and there is nothing to pay out |
| `booking.reminder.t1` | Template seeded in three languages; nothing emits the event | No devotee is reminded the day before their puja |

The outbox relay and the panchang job are scheduled too. `PayoutService.enforceCreditLimit`
is deliberately NOT on the scheduler — it takes one purohit, and sweeping the roster on a
timer to recompute a value that only changes when a booking settles belongs on the
settlement path, not on a clock.

---

## The web app is never deployed — now the first technical blocker

With payments deferrable and sign-in unblocked, this is the one that stops a launch
outright: there is nowhere for a devotee to go.

`fly.toml` and the CI deploy step cover **the API only**. CI builds the web app and then
discards it — there is no `apps/web/Dockerfile`, no host configuration, and no deploy
job. The backend ships to Fly in Mumbai on every merge to `main`; the frontend ships
nowhere.

Also: `readyz` checks Postgres but not Redis. Redis holds the slot locks and the rate
limit counters, so an instance whose Redis is unreachable passes readiness and is given
traffic it cannot serve correctly.

---

Open engineering gaps in the code itself are tracked in
[`ARCHITECTURE.md`](ARCHITECTURE.md#known-gaps), not here.

---

## Before the first real booking

- [ ] **An email provider** for `EMAIL_API_URL`/`EMAIL_API_KEY`. This is now the shortest
      path to working auth: password sign-in needs nothing, but a forgotten password is
      unrecoverable without a way to send a reset, and production refuses to boot with
      neither email nor a messaging provider
- [ ] **Somewhere to deploy the web app**, and a CI step that deploys it
- [ ] Razorpay account live; **escrow hold duration confirmed in writing** — not needed
      while `PAYMENTS_ENABLED=false`, required the moment it is switched on
- [ ] CA sign-off on the s.194-O cash treatment and the GST s.9(5) question. **More
      pressing under cash-only, not less**: every booking is then a cash booking, and the
      TDS carry has no digital payout to come out of
- [ ] WhatsApp templates approved; `provider_template_name` populated. No longer gates
      sign-in; gates notification quality
- [ ] Panchang validated for both schools by the consulting purohit
- [x] The account-takeover path in `register()` closed — `register()` now refuses an
      existing phone or email outright, with one message for both cases so it cannot be
      used to enumerate which numbers are registered
- [x] `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` rotated to real random values —
      **enforced at boot.** `min(32)` was only a length check, and `.env.example` ships
      `change-me-32-chars-minimum-please!!` at 35 characters, so the published
      placeholder passed it. That value is in the repository: anyone who can read it
      could sign an access token for any user id and any role, including `admin`.
      Production now refuses to start on a `change-me` secret. **You must still set real
      ones in the deployment's secret store**
- [x] `REDIS_URL` required, not optional — **enforced at boot.** Its absence fell back to
      `MemoryKv` silently, which on more than one instance makes rate limits per-process
      (the OTP send limit is bypassed by landing on another machine), OTP codes
      unverifiable across instances, and slot holds unshared. None of that fails loudly
- [ ] Postgres moved off any scale-to-zero tier to an always-on plan
- [ ] Automated backups with a **restore actually rehearsed**, not just configured
- [ ] Sentry or equivalent wired up; nothing reports errors today
- [ ] Daily reconciliation — aggregator settlement report against the ledger. Alert on
      *aged* unmatched items, not any drift: fees, TDS timing and T+1 lag create
      legitimate transient differences, and a zero-tolerance alert pages you into
      ignoring it
- [ ] DPDP: data export and deletion endpoints, and a written pseudonymisation policy
      reconciling the 30-day deletion SLA against 6–8 year GST retention
- [ ] Load test at ~5 bookings/minute sustained
- [x] A scheduler for the unrun jobs — `Scheduler` runs stale accepts, review publishing,
      anniversary nudges, join-link chasing, series codes and the KYC image purge
- [ ] Weekly payouts and T-1 reminders onto that scheduler (the two it does not yet run)
- [ ] `readyz` checking Redis as well as Postgres — Redis holds the slot locks, OTP codes
      and rate-limit counters, so an instance whose Redis is unreachable currently passes
      readiness and is given traffic it cannot serve correctly
- [ ] Integration-seam tests. The transactional core is covered in depth (871 API tests
      against a real Postgres engine), but three correctness bugs found in one session on
      26 Oct all sat at seams between components — a controller schema silently dropping
      two query parameters so the purohit availability filter never ran at all, a
      re-match path still asking the pre-ADR-0013 slot grid, and a sign-in hand-off
      reading a field its writer had stopped producing. Each was invisible because the
      tests drove one side of the seam and the other side was correct in isolation. That
      coverage shape predicts more of the same

---

## Two things worth reconsidering, which are not engineering

**The purohit economics don't work at the stated targets.** 100 purohits and 1,000
bookings over 90 days is **3.3 bookings per purohit per month**, against a persona who
performs 15–40. You would supply 10–20% of their work while asking them to keep a calendar
current, answer quickly, and give up 15%. Consider 30 purohits at 11 bookings a month
instead — real income, and a fill rate that is achievable rather than aspirational.

**Nothing protects the second booking.** The token secures booking one. After that the
purohit has been to the devotee's home and both have each other's numbers. This is
probably not solvable in R1 and probably shouldn't be — but add **repeat rate through the
platform** to the metric set now, so you measure the leak rather than discover it in month
six.

---

## Discrepancy noted

The vision deck says 10% commission for digital payments; the PRD says 12%. The
implementation uses **12%** (`COMMISSION_BPS.fully_digital`), matching the PRD. Worth
settling deliberately — at these volumes the difference is small, but it is the number
that appears on every invoice.

---

*Regulatory points are flagged for professional review. This document is not tax or legal
advice.*
