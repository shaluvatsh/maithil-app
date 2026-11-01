# ADR 0013 — Continuous time, with a travel buffer computed per booking

Status: accepted, 27 August 2026. Not yet implemented — scheduled after the payment
and OTP launch blockers in [PRODUCTION.md](../PRODUCTION.md).
Supersedes the slot grid in ADR 0006 (the `slot_span` reasoning there still holds;
the fixed four-slot day does not).

---

## Context

A day is four fixed three-hour slots with a published 30-minute gap between them:
`06:00–09:00`, `09:30–12:30`, `13:00–16:00`, `16:30–19:30`. The devotee books a slot,
not a time.

The 30 minutes is turnaround — a purohit finishes at one household and has to reach
the next. But it is charged to the wrong side of the marketplace. It is **demand** that
sees the constraint (a family wanting 10:00 is offered "09:30–12:30"), while the thing
the gap actually protects is a **supply** constraint that varies per pair of bookings
and is not modelled at all: whether *this* purohit can get from *that* address to
*this* one in time.

Four consequences, in order of how much they cost:

**It cannot express a muhurat.** Muhurat-sensitive rituals take their time from the
panchang — Abhijit runs 11:15–12:06 on a given day, not "the late-morning slot". The
panchang is computed, materialised and rendered, and then the booking flow rounds it
off to a three-hour bucket. This is the product's differentiator being discarded at the
last step.

**The day is the wrong length, and the catalogue already proves it.** Slots run
06:00–19:30. Three rituals we currently sell cannot happen inside that window at all:

| Ritual | What the catalogue says | Actual time |
|---|---|---|
| Kali Puja | *নিশীথে — "Midnight Kali Puja with homa"*, 180 min | ~23:30–02:30 |
| Shiva Ratri | *চার প্রহরে — "Four-prahar Shiva worship"* | sunset → sunrise |
| Janmashtami | Nishita Kaal | around midnight |

`occasions.ts` states it plainly — *"Performed at home on Amavasya night, so the slot
runs late."* The product knows these are night rites and the scheduler offers a 6am
slot for them. At the other end, **Brahma muhurta** — the most auspicious window of the
day for many rituals — begins around 04:00, also outside the grid.

None of this needs new astronomy. `astronomy.ts` already computes sunrise and sunset
(NOAA) per city, and the panchang already derives windows from them
(`abhijitWindow(sunrise, sunset)`, `rahuKaalWindow(...)`). Brahma muhurta
(sunrise − 96 min to sunrise − 48 min), Nishita Kaal (solar midnight ± 24 min) and the
four prahars of the night all fall out of values that are already materialised.

**The buffer it exists for has never once fired.** `applyTravelBuffer` blocks a
neighbouring slot when travel exceeds the city's gap, but it is guarded by
`travelMinutes <= region.travelGapMinutes` and `travelMinutes` is hardcoded `25` at
both call sites. 25 ≤ 30 in Kolkata, and ≤ 45/60/75 everywhere else, so it returns
early every time. There is no Maps integration; the "call the Maps API once at
confirmation" that `search.service.ts` describes was never built. So a purohit is
bookable for four back-to-back slots with 30 minutes between them regardless of whether
the two homes are 2 km or 25 km apart, and ADR 0006's "effective capacity is 2–3
slots/day" — the number the purohit income model rests on — is documented and coded for
but not enforced.

**A slot is a coarse unit of inventory.** A 45-minute Namkaran consumes three hours.

## Decision

**Bookings occupy an arbitrary interval. Feasibility is a routing question answered per
purohit, per booking.**

### The devotee picks a time, on a 24-hour clock

Start times are offered in **30-minute steps** across the **full 24 hours**, bounded by
the purohit's declared working hours rather than by a platform-wide 06:00–19:30 window.
The booking occupies `[start, start + ritual.duration_min]`.
`bookings.slot_start_at` / `slot_end_at` already exist and already carry this (ADR 0006
denormalised them so deadlines were indexable); they become the primary representation
rather than a derived convenience. `slot_idx` and `slot_span` are retired.

30 minutes rather than 15: four times more choice than today, small enough to check
feasibility across a ranked candidate set, and a familiar picker. Muhurat windows —
Brahma muhurta, Abhijit, Nishita — are surfaced as **highlighted suggestions on top of
the grid**, computed from the sunrise/sunset the panchang already materialises. The grid
is the fallback; the muhurat is the recommendation.

### A booking's date is the observance date, not the wall clock

Kali Puja begins at 23:40 and ends at 02:40. The wall-clock date of the *start* is one
day; of the *end*, another; and the **tithi** it belongs to may be a third. A booking
must not be filed under whichever of those the clock happens to produce, or Kali Puja
appears in the devotee's list on the day after Kali Puja.

`bookings.date` therefore means **the observance date** — the day the ritual is *for*,
which is what the devotee chose, what the panchang anchors, and what every reminder and
receipt should say. It is set explicitly at draft time and is not derived from
`slot_start_at`. Occupancy and travel are computed purely from the timestamps; `date` is
a label for humans and for tithi lookup, never an input to scheduling.

This also means a night booking's *muhurat* is looked up against the observance date's
panchang row, not against the calendar day its clock time falls in.

### Feasibility replaces slot inventory

For a candidate purohit and a requested `[S, E]` at address A:

```
prev = their latest live booking ending ≤ S
next = their earliest live booking starting ≥ E

feasible ⟺ prev.end + travel(prev.addr → A) ≤ S
        ∧  E + travel(A → next.addr)       ≤ next.start
        ∧  [S, E] within declared working hours, and not inside a blocked period
```

`region.travelGapMinutes` stops being *the* gap and becomes the **floor** — the minimum
turnaround at any distance, for parking, packing samagri and greeting the family:

```
buffer = max(region.travelGapMinutes, estimatedTravel)
```

### Travel time is estimated, not fetched

**Haversine × a per-city average speed.** The Haversine expression already exists in
`search.service.ts`, `addresses.lat/lng` are `NOT NULL`, and `pandit_profiles` carries
`base_lat/base_lng`. It is free, synchronous, and cheap enough to evaluate inside the
allocation check across a ranked candidate set.

Rejected: **Distance Matrix on the search path** — it bills per origin-destination
element and re-ranking 25 candidates on every filter change is the cost bomb
`search.service.ts` explicitly avoided. Rejected for now: **Distance Matrix at
confirmation only** — accurate where it matters, but it needs a key and billing, and
the call would have to happen strictly *before* the payment transaction opens, since
that transaction already holds one of ten pooled connections. Worth revisiting once
there is pilot data on how wrong the estimate actually is; the floor and a safety
multiplier absorb the error until then.

Straight-line distance under-reads real driving, so the estimate is deliberately
conservative: it is better to leave a purohit idle than to promise a family a purohit
who arrives an hour late for a muhurat.

### Correctness under concurrency

Two layers, mirroring the ones the slot model already uses.

**1. A hard database guarantee.** A partial GiST exclusion constraint — two live
bookings for one purohit can never overlap, whatever the application believes:

```sql
ALTER TABLE bookings ADD CONSTRAINT bookings_pandit_no_overlap
  EXCLUDE USING gist (
    pandit_id WITH =,
    tstzrange(slot_start_at, slot_end_at) WITH &&
  ) WHERE (state IN ('pending_accept','confirmed','in_progress','completed'));
```

Partial, so a cancelled or expired booking stops reserving the time. `btree_gist` is
already installed and `panchang_intervals` already carries exactly this shape of
constraint, for the same reason: a job and a human can race.

**2. An advisory lock for the travel rule.** The exclusion constraint cannot express
the travel rule, because feasibility depends on the *neighbouring* booking's address —
it is a property of a pair, not of a row. So allocation takes

```sql
pg_advisory_xact_lock(hashtext(pandit_id))
```

which serialises concurrent allocations for one purohit and releases at COMMIT.
Advisory locks are already used for the panchang job.

**Keyed on the purohit alone, deliberately — not on `(pandit_id, date)`.** A booking
running 23:40–02:40 has neighbours on *both* calendar days, and the job at 03:30 the
next morning needs a travel check against it. A date-keyed lock would put those two
allocations on different keys, so neither would see the other: the exclusion constraint
would still catch a literal overlap, but the *travel* rule — the whole point of the
lock — would be evaluated against a stale picture, and a purohit could be committed to
two jobs an hour and twenty minutes apart across town. Contention is not a concern at
this granularity: one purohit is a handful of concurrent attempts, not a hotspot.

This replaces `SlotService.lockAndBook`'s `FOR UPDATE` over discrete availability rows.

### Working hours must be able to cross midnight

A purohit who takes Kali Puja work is available 22:00–03:00, which is not expressible as
a `start < end` range on one weekday. `pandit_weekly_patterns` stores an ordered pair
per weekday; a window where `end <= start` is read as **crossing into the next day**,
the same convention shift rosters use. Feasibility evaluates against the concrete
`[start, end]` instants after that expansion, so nothing downstream needs to know.

### Peak season is a different shape of day, not more of the same day

Durga Puja, Kali Puja and Diwali are not "a busy Tuesday". Four things change at once,
and the model has to bend rather than break:

**Hours extend.** A purohit may work 04:00–01:00 across the festival. That is a
*per-date override*, not a weekly pattern: `pandit_date_overrides (pandit_id, date,
windows[], travel_floor_minutes)`, which replaces the weekly pattern for that date. The
same table serves the opposite case — a purohit blocking a day off.

**Turnaround shrinks legitimately.** During Durga Puja a purohit performs at six homes
in one *para*, sometimes in one building. A 30-minute floor that is right for a normal
day is wrong there, and would silently cap them at a third of the work they can actually
do. Hence `travel_floor_minutes` on the override: the purohit lowers their own floor for
that date. Haversine already handles the short distances; it is the floor that needs to
move, and only the purohit knows their para.

**Demand concentrates on a few instants.** Everyone wants the same muhurat on the same
date from the same handful of purohits. The per-purohit advisory lock is exactly the
right granularity for that — contention is confined to one purohit's row rather than a
global slot table — and the exclusion constraint backstops it. Expect the honest answer
("nobody is free at that muhurat") to be common at peak, which makes the *alternative
suggestions* on the time picker the important surface, not an afterthought.

**Booking happens far ahead.** `BOOKING_HORIZON_DAYS` is 120. That covers a Durga Puja
booked four months out but not a wedding season planned a year ahead. Not changed here,
but flagged: the horizon is now the binding constraint on pre-booking, not the slot
model, and it is a one-constant change plus a materialisation cost.

## Consequences

**The availability materialisation goes away.** `availability` currently holds one row
per purohit per date per slot — 480 rows each over the 120-day horizon, written by a
chunked job. Occupancy becomes the bookings table itself; *availability* becomes
`pandit_weekly_patterns` (which already exists) plus explicit blocked periods. This
deletes a table's worth of derived state and the job that maintains it.

**The purohit calendar changes meaning.** Today it is "open and close these slots".
It becomes "these are my working hours, and these specific periods are blocked" — which
is both less work for the purohit and a truer statement, since it stops implying they
control four discrete buckets.

**Capacity becomes real, and moves in both directions.** Once the buffer actually fires,
a purohit with two jobs on opposite sides of Kolkata genuinely cannot take a third
between them — a visible drop in bookable inventory the day it ships, and the income
model must already be using the real number rather than four slots. But the 24-hour
clock and the peak-season override move it the *other* way: a purohit doing six homes in
one para on Ashtami, or a midnight Kali Puja that was previously unbookable entirely, is
capacity the slot grid could not represent at all. "2–3 slots/day" was a normal-weekday
figure and should not be projected across a festival week.

**Night work is a real safety and consent question, not just a scheduling one.** The
model now permits a 02:00 booking. Whether a given purohit wants one is theirs to
declare, which is what the weekly pattern and the date override are for — the default
must be that they are *not* available overnight unless they say so. Defaulting the other
way would quietly enrol every purohit in night work.

**Search gets more expensive.** The availability filter is a relational division over
`generate_series` today. It becomes a range-overlap plus a per-candidate travel check.
Bounded by the candidate limit (25) and by loading each candidate's bookings for one
date, but it is no longer a single set-based predicate and needs an index on
`(pandit_id, slot_start_at)`.

**Reschedule and substitution get harder, correctly.** Moving a booking, or handing it
to a replacement purohit, must re-check feasibility against that purohit's other jobs.
Today both only check that a slot row is `open`.

**Geocoding becomes load-bearing twice over.** ADR 0012 already flagged that addresses
saved through the new form carry `lat/lng` of `0`, making the proximity term score
against the Atlantic. Under this ADR the same bad coordinate also produces a nonsense
travel estimate and therefore a nonsense allocation. **Geocoding must be fixed before
this ships**, not alongside it.

**Migration is not a schema change alone.** Existing bookings carry `slot_idx`/
`slot_span`; their `slot_start_at`/`slot_end_at` are already populated, so the data
migrates cleanly, but the exclusion constraint will reject any historical overlap that
the slot model allowed through. Audit before adding the constraint.

## Alternatives considered

**Keep slots, shrink them to 30 minutes.** Forty-eight slots a day instead of four.
Finer inventory without changing the model — but it multiplies the materialised rows
twelvefold, still cannot express a muhurat that starts at 11:15, and still charges the
travel constraint to the devotee. It buys granularity and none of the correctness.

**Keep the grid and bolt on a "night slot".** Add a fifth slot, 22:00–01:00, for Kali
Puja and Shiva Ratri. Cheap, and it makes the three unbookable rituals bookable — but it
encodes one festival's timing as a constant, does nothing for Brahma muhurta at 04:00,
and leaves the next night ritual needing a sixth slot. The catalogue's night rites do not
share a window; they share the property of being derived from sunrise and sunset.

**Keep slots for the devotee, run the buffer only behind them.** Fix
`applyTravelBuffer` (feed it a real travel estimate) and leave the grid alone. This is
strictly less work and fixes the unenforced-capacity half of the problem — but it
leaves the muhurat rounding in place, which is the half that costs the product its
differentiator. Worth doing *as an interim* if this ADR slips.
