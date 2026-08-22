# ADR 0011 — Booking into a published slot is auto-accepted

Status: accepted, 12 August 2026.
Supersedes the acceptance behaviour assumed by ADR 0006.

---

## Context

The flow was: devotee submits → `pending_accept` → purohit accepts within two hours →
devotee pays the token → `confirmed`. `confirmOnTokenCapture` refused to proceed
without `acceptedAt`.

Three things were wrong with it.

**The interface never mentioned it.** The devotee was shown "Pay ₹255 to confirm"
immediately after booking. Pressing it threw *"purohit has not accepted this booking
yet"*. The gate existed in the state machine and nowhere on screen, so the only way to
discover it was to hit the single button offered and have it fail.

**The supply side cannot service a two-hour window.** The purohit persona in DESIGN.md
is 30–65, on a low-end Android, "sometimes outdoors, often one-handed", and frequently
mid-ritual. A purohit performing a four-hour biye cannot answer a phone. The window
would expire routinely and the devotee would lose the slot **because the purohit was
working** — the failure mode is worst for exactly the purohits we most want.

**It made the core claim untrue.** COMPETITIVE-ANALYSIS.md establishes the wedge:
nobody in the category sells an instantly confirmed, slot-locked booking; all five
at-home competitors are "we will allocate someone within 24–48 hours". A two-hour
acceptance window is a shorter version of the same limbo. The devotee still leaves the
checkout not knowing whether they have a purohit.

## Decision

**Publishing availability is the acceptance.** `submit()` sets `acceptedAt` at the
moment the booking is created, so the devotee can pay immediately and the slot is
locked on capture. No second confirmation is asked of the purohit.

The `accept_deadline_at` column stays, but its meaning changes: it is now the window
in which an unpaid booking is swept away, not the window in which a purohit must
answer. A devotee who books and never pays releases the slot after two hours, which is
the behaviour you want; the event name `booking.expired` is now slightly misleading
about the cause and should be renamed when someone touches it.

`accept()` remains on the service and the controller. It is a no-op against a booking
that is already accepted, and is kept so the purohit app's existing call does not
break mid-rollout. It should be removed once that app ships a version without it.

This is the Urban Company / Uber model: the platform guarantees supply and reassigns
silently, rather than the Airbnb request-to-book model where the customer waits on a
host.

## Consequences

**The calendar becomes load-bearing.** Auto-accept is only safe if published
availability is honest. On-platform double booking is already impossible — the slot
engine takes `FOR UPDATE` over the contiguous span with a unique index behind it — but
an off-platform commitment the purohit never recorded will now collide with a confirmed
booking rather than a pending request.

**There is no `decline()`, and that is now the biggest gap.** A purohit's only exit is
`cancel()` with `actorRole: 'pandit'`, which lands the booking in `cancelled_pandit` —
the same state, and the same reputational weight, as abandoning a confirmed job the
day before. Under the old flow a purohit could simply not accept and let the window
lapse, at no cost. Auto-accept removes that quiet exit without providing a cheap one,
so the first thing to build is:

- `decline(bookingId, panditId, reason)`, valid only before token capture, separate
  from cancellation in both state and reputation
- a response/reliability score on `pandit_profiles`, surfaced in search ranking, so
  declining early is cheap and declining late is not
- re-match on decline: the events already fire, nothing consumes them (PRODUCTION.md,
  "not built" item 7)

Until `decline()` exists, auto-accept is strictly harder on purohits than the flow it
replaced. **That should be built before onboarding real supply, not after.**

**Onboarding must say this out loud.** A purohit who believes they will be asked
before each job will be angry the first time one simply appears. The purohit app needs
to state, at signup and on the calendar screen, that an open slot is a commitment.

**Cancellation policy now carries the risk that the accept window used to.** A purohit
declining at T-2h is materially different from declining at T-48h, and the refund and
penalty tables should reflect that.

## Alternatives considered

**Keep approval, show it honestly** — an "Awaiting confirmation" screen with a live
countdown, card authorised at booking and captured on acceptance. Correct as UX, and
the safer choice for purohits, but it keeps the limbo that is the category's main
weakness and does not fix the responsiveness problem.

**Hybrid by track record** — auto-accept for purohits above a response-rate threshold,
approval for new ones. Probably where this ends up. Rejected for R1 because the
threshold needs data that does not exist yet, and because two booking semantics in one
product is hard to explain to either side of the marketplace.
