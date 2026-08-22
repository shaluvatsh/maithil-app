# ADR 0012 — The platform assigns the purohit

Status: accepted, 12 August 2026.
Builds on ADR 0011 (auto-accept).

---

## Context

The booking flow had four steps: service, date and time, **pandit**, confirm. Step
three was a grid of purohit cards — name, years, languages, distance, rating, price —
and the devotee picked one.

They cannot. "18 years" against "22 years" is not a decision a family can make about
their daughter's Annaprashan. Neither is 4.7 against 4.8, on rating counts of zero.
The step asked the devotee to arbitrate between strangers on evidence that does not
discriminate, which is not choice — it is the platform declining to do its job and
calling it agency. On a ₹15,000 ceremony that reads as risk.

Meanwhile the ranking that produced the list was already better informed than the
devotee: it scores rating, proximity, acceptance rate and price fit, with a boost for
new supply. It sorted the grid and then asked the user to second-guess it.

## Decision

**`panditId` is optional on `POST /v1/bookings`. Omit it and the platform assigns.**

Matching runs server-side in `createDraft`, using the same `SearchService` ranking
that ordered the old list, with `experience` added as a fifth term at weight 0.10 —
years served was previously not scored at all, because the devotee could read it
themselves and now nobody does.

The booking flow is three steps: **service → date and time → confirm.**

The devotee is always **told** who was assigned, before paying, with the reason:
*"Ramesh Jha, 18 years — matched for your vidhi and language, nearest to you."*
They do not choose, but a stranger arriving at a family's home on a named day is not
an anonymous transaction, and the match reason is a sentence no competitor can render
because none of them hold the data.

Booking a **named** purohit stays supported — `panditId` is still accepted — and
becomes a separate entry point from a purohit's profile or a past booking. That flow
must never silently substitute, because substitution is the entire point of the
default flow and precisely wrong here.

## Consequences

**Matching is now load-bearing.** It was a sort order over a list the user could
override; it is now the allocation of work and income. A bug in the weights is a bug
in someone's livelihood. The weights need to be observable — log the chosen purohit
and the runner-up per booking — before supply grows.

**`experience` is capped at 25 years.** Linear would hand the marketplace to whoever
has practised longest and freeze out new purohits permanently. It is also weighted
below rating and proximity deliberately: years served is a weak proxy for quality.

**Distance is wrong for new addresses.** Addresses saved through the new form carry
`lat/lng` of `0`, so the proximity term — 25% of the score — is computed against the
Atlantic. Geocoding was a nice-to-have when the devotee could see "3.2 km away" and
judge; it is now a correctness issue in the assignment itself. **Fix before pilot.**

**Fairness needs watching.** A pure score maximiser gives every booking in an area to
the same one or two purohits and starves the rest, who then stop maintaining their
calendars, which makes the ranking more concentrated still. The new-supply bonus is a
partial guard. A round-robin tiebreak among near-equal scores, or a load term, will be
needed once there are more than a handful of purohits per area.

**"No purohit is free" is now a booking-time error.** Previously an empty slot showed
an empty grid at step three. Now `createDraft` throws, and the flow has to render that
well — which it does at the slot step, before the devotee has invested in the rest of
the form.

## Alternatives considered

**Show the match with a "choose someone else" link.** One card, auto-selected, with an
escape hatch. Recommended initially and rejected by the product owner in favour of no
selection at all in the default path. Reasonable: the escape hatch reintroduces the
same undecidable comparison for the minority who click it, and the named-purohit flow
covers the real need — booking someone your family already knows.

**Keep the grid.** Rejected. It is the weakest part of the flow and the only step that
made the devotee do the platform's work.
