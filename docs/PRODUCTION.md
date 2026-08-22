# The Maithil — production readiness

Honest assessment as of 3 August 2026. Read this before taking a rupee from a real devotee.

---

## Verdict

The **transactional core is production-grade**: money movement, the booking state
machine, slot concurrency, payment capture and settlement are correct, constrained at the
database level, and covered by 124 tests that run against a real Postgres engine.

The system is **not yet ready to serve real customers**, for reasons that are mostly not
about code quality. Four of them are blocking, and two of those are legal rather than
technical.

---

## Blocking — cannot go live

### 1. No payment credentials, and the escrow question is unresolved ⚠️

Razorpay Route is implemented end to end — order creation, HMAC webhook verification,
exactly-once processing, refunds, held transfers. It has never touched Razorpay's
sandbox, because there is no merchant account yet.

Worse, the **maximum escrow hold duration is still an open question**. The booking model
holds the token from confirmation until the ritual is performed. RBI's Payment Aggregator
Directions require settlement to the merchant within T+1; Route's settlement-hold feature
is the mechanism, but its limits are not confirmed. This matters most for exactly the
bookings you want: a muhurat booked a month out, festival pre-booking, subscriptions.

**If holds turn out to be capped**, the design changes: token captured at confirmation,
balance charged at T-2 rather than on completion. That is a real change to
`BookingService` and the settlement planner. Resolve it before writing more payment code.

Also expect **7–14 day settlement holds on a new merchant account**. Your Phase-1 promise
of weekly payouts plus instant payout will not be true in month one, and purohits will
notice immediately.

### 2. The cash tax treatment needs a CA's signature ⚠️

`settlement.ts` implements what I believe is correct: because s.194-O deems the operator
to have made the payment even when the devotee pays the purohit directly, cash bookings
post a notional credit and an offsetting `cash_settled_direct` debit so the withholding
base is right, with the un-takeable withholding carried to the next digital payout.

That is a considered reading, not professional advice. **Have a CA confirm it**, and at
the same time answer the bigger question: does **GST s.9(5)** e-commerce-operator
liability apply, given most purohits will be below the registration threshold? If it
does, the platform owes GST on the full service value, which changes unit economics
materially — not just the code.

### 3. WhatsApp templates are not approved

The notification pipeline is built and tested, with SMS fallback. But WhatsApp will not
deliver operator-initiated messages outside a 24-hour window without a **BSP-approved
template**, and approval takes 1–2 weeks per batch. Six templates are seeded in Bengali;
`provider_template_name` is null on all of them, and the channel fails loudly rather than
silently dropping.

Until this lands, every notification falls through to SMS — which works, costs more, and
is a worse experience in a WhatsApp-first market.

### 4. Panchang has no data source

This is the differentiator (ADR 0003) and it is the largest *functional* gap. The schema
models both panjika schools as intervals and the UI is ready for it, but:

- no provider client, so `panchang_intervals` and `panchang_days` are empty
- no nightly materialisation job
- no admin screen for the annual Gupta Press entry
- slot annotations return `containsAbhijit: false` for everything

The interval maths is written and tested (`domain/panchang.ts`). What is missing is the
plumbing and, more importantly, **the consulting purohit** who validates it. Shipping
wrong muhurat dates in Kolkata is worse than shipping none.

---

## Built and production-grade

| Area | State |
|---|---|
| Booking state machine | Declarative transition table, guards, audit rows, outbox events — all in one transaction |
| Slot concurrency | Redis soft hold + `FOR UPDATE` over a contiguous span + unique index. Tested with the hold removed |
| Double-entry ledger | Append-only, deferred constraint trigger enforcing debits == credits at COMMIT |
| Settlement | Cash and digital, TDS on both, dues only from promo exceptions |
| Payments | Order creation, HMAC-verified webhooks, exactly-once via `webhook_events`, refunds |
| Payouts | Gross − dues − carried TDS − instant fee, credit-limit enforcement |
| Notifications | Template rendering, locale fallback, channel fallback, consumer-side dedupe |
| Auth | Phone OTP, hashed and constant-time compared, rate limited on send *and* verify |
| Idempotency | On completion, cancellation and payment; conflicting replays rejected |
| Hardening | Security headers, per-route rate limits, request IDs, graceful shutdown, liveness vs readiness |
| Deployment | Multi-stage Docker, non-root, healthcheck; Fly config in `bom`; CI with migrations as a release command |

**124 tests.** The integration suites run Postgres 18 compiled to WebAssembly in-process,
so CI needs no database service and still exercises the real triggers and constraints.

---

## Not built

Roughly in the order I would build them.

1. **Panchang provider + nightly job** — see blocker 4.
2. **Reviews** — schema exists, double-blind publish job and API do not. Ratings feed
   search ranking, which currently runs on the Bayesian prior alone.
3. **Admin verification actions** — the console lists purohits and their KYC status but
   cannot approve or reject. Onboarding is a `psql` update today.
4. **Mobile apps** — the PRD wants Android-first devotee and purohit apps. There is one
   responsive web app covering all three surfaces. This is months, not weeks.
5. **Samagri partner kits** — cut from R1 by ADR 0008. Option A (purohit brings) works.
6. **E-puja, subscriptions, referrals** — all cut from R1.
7. **Re-match on decline/expiry** — the events fire, nothing consumes them.
8. **GST invoice PDFs** — required by the PRD, not implemented.

---

## Before the first real booking

- [ ] Razorpay account live; **escrow hold duration confirmed in writing**
- [ ] CA sign-off on the s.194-O cash treatment and the GST s.9(5) question
- [ ] WhatsApp templates approved; `provider_template_name` populated
- [ ] Panchang live for both schools, signed off by the consulting purohit
- [ ] `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` rotated to real random values
- [ ] Postgres moved off any scale-to-zero free tier to an always-on plan
- [ ] Redis provisioned — rate limits and slot holds are per-process without it, which
      breaks the moment you run two instances
- [ ] Automated backups with a **restore actually rehearsed**, not just configured
- [ ] Sentry or equivalent wired up; nothing reports errors today
- [ ] The daily reconciliation job — aggregator settlement report against the ledger.
      Alert on *aged* unmatched items, not on any drift: fees, TDS timing and T+1 lag
      create legitimate transient differences and a zero-tolerance alert will page you
      into ignoring it
- [ ] DPDP: data export and deletion endpoints, and a written pseudonymisation policy
      reconciling the 30-day deletion SLA against 6–8 year GST retention
- [ ] Load test. The target should be ~5 bookings/minute sustained, not the 50 in the
      original plan — that was three times the entire 90-day goal, per minute

---

## Two things worth reconsidering, which are not engineering

**The purohit economics don't work at the stated targets.** 100 purohits and 1,000
bookings over 90 days is **3.3 bookings per purohit per month**, against a persona who
performs 15–40. You would be supplying 10–20% of their work while asking them to keep a
calendar current, answer within two hours, and give up 15%. Consider 30 purohits at 11
bookings a month instead — real income, and a fill rate that is achievable rather than
aspirational.

**Nothing protects the second booking.** The token secures booking one. After that the
purohit has been to the devotee's home and both have each other's numbers. This is not
solvable in R1 and probably shouldn't be — but add **repeat rate through the platform**
to the metric set now, so you measure the leak rather than discover it in month six.

---

## Discrepancy noted

The vision deck says 10% commission for digital payments; the PRD says 12%. The
implementation uses **12%** (`COMMISSION_BPS.fully_digital`), matching the PRD. Worth
settling deliberately — at these volumes the difference is small, but it is the number
that appears on every invoice.

---

*Regulatory points are flagged for professional review. This document is not tax or legal
advice.*
