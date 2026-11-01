# ADR 0015 — Events are not bookings

Status: accepted, 19 September 2026. Not yet implemented — this decision precedes C2.
Builds on ADR 0006 (slot model) and ADR 0014 (community bounded context).

---

## Context

The community surface lists religious events — a Mahalaya tarpan at a ghat, a nine-day
Chandi Paath at a temple, an evening kirtan — and lets a devotee reserve a place in
advance.

Both a booking and an event occupy time, involve a purohit, and can take money. The
obvious move is to reuse `bookings`: the state machine exists, the slot model exists,
payments and the ledger are wired, and a seat looks like a slot.

It is the wrong move, and the reason is that the two share almost none of their
structure once you look past "something happens at a time".

| | Booking | Event |
|---|---|---|
| Participants | one devotee, one purohit | many devotees, one host |
| Venue | the family's own address | a temple, a ghat, a hall |
| Travel | buffered per pair of addresses (ADR 0013) | none — nobody travels to anybody |
| Samagri | a BOM, priced and frozen | none |
| Start / finish | OTP handshake at the door | nobody knocks on a door |
| Cancellation | refund tiers at 24 / 48 h, TDS on cash | a temple event is called off, or it rains |
| Failure mode | `cancelled_pandit`, dispute, payout reversal | undersubscribed, or a no-show rate of 50% |

`bookingStateEnum` would have to carry `cancelled_pandit`, `in_progress` and
`offlineCaptureAt` on a temple kirtan. `bookings` would need a nullable `addressId` that
is always null, a `samagriOption` that is always `none`, a `slotSpan` against a slot grid
the venue does not use, and a `panditId` for an event a devotee listed. Every one of
those is a column that lies, and each one weakens a state machine that is currently
correct and load-bearing.

## Decision

**Events get their own tables and their own state machine, inside the community context.**

`events` · `event_sessions` · `event_registrations`, alongside the C1 tables, under
ADR 0014's rule that nothing in booking may reference them.

**What is reused, because it is genuinely the same problem:**

- **The ledger.** All money, always, double-entry, with new entry types
  `event_ticket`, `event_refund`, `event_commission`. There is no second place money
  is recorded (ADR 0004).
- `payment_intents` and the Razorpay integration.
- The transactional outbox for every side effect (ADR 0005).
- `pincode_centroids` and the Haversine pattern for "near me".
- The Redis hold pattern, for a seat held while payment completes.
- The OTP-hash pattern, for check-in at the door.
- The panchang engine, to label an event with the tithi it falls on — per the
  *reader's* almanac, not the host's.

**Capacity lives on `event_sessions`, not on `events`.** A nine-day paath is nine
sessions and three daily aartis are three; capacity, price and seats-taken are
properties of a session.

**Capacity is community's ledger invariant, and it is enforced in SQL:**

```sql
ALTER TABLE event_sessions ADD CONSTRAINT seats_within_capacity
  CHECK (capacity IS NULL OR seats_taken <= capacity);
```

with `SELECT … FOR UPDATE` on the session row inside the registration transaction.
Counting registration rows and comparing to capacity is a race, and under festival load
it will oversell. The CHECK is the seatbelt: a code path that forgets the lock fails
loudly instead of quietly seating 210 people in a hall of 200.

**Two liability tiers, expressed as `registrationMode` rather than as policy:**

| | Listed | Hosted |
|---|---|---|
| Who may create | anyone — devotee, purohit, temple | verified purohit or verified organisation |
| Money | none | ticketed, or seva slots |
| Registration | external link, or just turn up | seats, capacity, check-in |
| Our position | intermediary; shown as "listed by X, unverified" | ours, fully |
| Review | post-hoc, flag-driven | pre-publish, always |

**A devotee-listed event can never take money through the platform.** One enum value
removes an entire fraud class — the fake ticketed Durga Puja — and it removes it
structurally rather than by vigilance.

**Times are absolute instants.** `startAt` / `endAt`, never a local date plus a slot
index. ADR 0006 learned this for bookings in one city; across a national feed a local
date is not even well defined.

## Consequences

**Free events need overbooking and a waitlist.** Free RSVP no-shows run 40–60%. An event
that shows "full" and then runs half empty teaches hosts that the platform does not
work. The overbook factor is a deployment knob (`COMMUNITY_FREE_EVENT_OVERBOOK_BPS`,
default 1.2×), not a constant, because the right number is whatever the data says.

**Settlement is on event completion, not on purchase.** Money held between a ticket sale
and the event is the same escrow question ADR 0004 answered for bookings, and it has the
same RBI T+1 constraint noted in `PRODUCTION.md`.

**There is a tax question, and it must be asked before C2 ships.** Entry to a religious
ceremony is GST-exempt under Notification 12/2017 entry 13 below a per-person threshold.
If ticket prices sit under it, ticketed events may be exempt where marketplace
commission is not. Add it to the CA's list alongside the s.194-O and s.9(5) questions
already in ADR 0008's P0-0 — pan-India this is a large number of transactions to get
wrong, and it is cheaper to ask in the same conversation than to unwind later.

**Geo discovery needs a real index.** A btree on `(lat, lng)` cannot serve a radius
query. The pattern is a bounding-box prefilter on the indexed columns then Haversine to
order — the same approach `search.service.ts` already uses — with the degree deltas
derived from latitude, because Guwahati and Chennai are thirteen degrees apart.

**`geo_precision` must be honoured.** A city-centroid event is not at a location: every
event in Kolkata shares that point, the distance between two of them is exactly zero,
and "2.3 km away" computed from it is a fiction. Show "in Kolkata" instead.

**Two more things become possible that bookings cannot do**, and they are the reason
this is worth building at all: a purohit can fill otherwise-empty time with a group
event, and a devotee can meet a purohit before committing to a ceremony at home.

## Alternatives considered

**Reuse `bookings` with a `kind` discriminator.** Rejected — the table above is the
argument. A discriminator on a table whose columns are 60% inapplicable to one branch is
two tables that have not been separated yet.

**Model an event as N bookings, one per attendee.** Rejected. It multiplies the booking
table by attendance, makes the purohit's calendar unreadable, and every booking would
carry the same address, the same slot and no travel — while an oversell would show up as
a slot conflict rather than as the capacity error it is.

**Ship events before the Q&A board (C1).** Rejected. Events are the hardest piece —
capacity integrity, a money path, geo discovery, and the largest liability surface — and
they are worth building once there is evidence anyone shows up. C1 answers that for far
less work.
