# ADR 0014 — Community is a separate bounded context

Status: accepted, 19 September 2026.

---

## Context

The product needs a place where devotees and purohits talk: a question board, nearby
religious events with seats bookable in advance, and a library of learning content.
Three surfaces, one theme — content authored by users rather than by us.

That is a different kind of system from everything built so far, in three ways that
each break an assumption the existing code is entitled to make.

**One region per request stops being true.** `getRegion(citySlug)` resolves once at the
edge of every marketplace request and everything downstream inherits it — the slot
shape, the almanac, the numerals, the font subset. A community feed is scoped
nationally by design: one response carries Bengali, Devanagari and Tamil, and there is
no single region that describes it.

**The content is written by strangers**, in languages nobody on the team reads, and some
of it will be sectarian, casteist, communal, or an attempt to move a booking
off-platform. Marketplace content is authored and translated by us; none of that
machinery transfers.

**These tables grow with reads.** Bookings grow at the rate families hold ceremonies —
thousands. Posts, reactions and impressions grow at the rate people browse, they never
shrink, and the failure mode is a feed that was fast at a hundred rows and is not at a
hundred thousand.

There is also a risk that has nothing to do with engineering. A community surface is
the part of this product most likely to produce an incident — a defamation notice, a
takedown order, a communal flare-up during a festival. Whatever happens there must not
be able to stop a booking being taken.

## Decision

**Community is its own bounded context, and the dependency arrow only ever points out
of it.**

Concretely:

- One schema file, `apps/api/src/db/schema/community.ts`, and one module,
  `apps/api/src/modules/community/`.
- Community may hold foreign keys to `users`, `cities` and `rituals`. **Nothing in
  booking, ledger, payments, availability or payouts may reference a community table.**
- What community needs from the marketplace arrives as a **bound capability**, not as a
  service. It needs exactly one fact — whether a person has ever completed a booking,
  for the trust ladder — and that is a function passed in at composition time in
  `app.module.ts`, the same shape as `matchPandit`. `CommunityService` does not import
  `BookingService` and does not know the `bookings` table exists.

**The test of the boundary: you could `DROP` every community table and still take a
booking.** If that stops being true, the coupling is wrong and a moderation incident has
become a marketplace outage.

Two further decisions follow from the three breakages above and are part of this one:

**Scope is a column, never an inference.** Every community row carries
`scope ∈ {city, state, national}` plus the matching target, and the pairing is a `CHECK`
constraint rather than a service rule. A feed query that forgets its scope predicate
returns a national firehose, and in Kolkata-only development data that is
indistinguishable from correct.

**Content locale is a different enum from UI locale.** `locale` has three values because
the interface exists in three languages. `content_locale` has eleven because that is how
many are spoken in the cities `packages/region` already serves. Merging them means
either rejecting a Tamil question outright or defaulting it to the launch city's
language and filing a Chennai question as Bengali — data present, mislabelled, routed to
the wrong purohits, and no error at any layer. `content-locale-parity.test.ts` pins the
two sets and the separation, for the reason `panjika-parity.test.ts` exists.

## Consequences

**Community cannot read booking history, and must not learn how.** The trust ladder is
the only place the two systems touch. Anything that later wants "show the ritual you
booked next to your question" is a request to breach this boundary and should be
answered with a capability, not an import.

**Identity is split, deliberately and permanently.** A devotee's community presence is a
display name they chose and nothing else — no phone, no city, no booking history.
Devotees book for the shraddha of a dead parent, for a fertility rite, for an illness;
none of that may surface because they also asked a question. `users.name` is read in
exactly one place in the community context, to seed a *purohit's* profile, and appears
nowhere else. The asymmetry is the product: identifiable expertise answering anonymous
vulnerability.

**The purohit tick is read live, never copied.** `kyc_status` is joined at render time
rather than denormalised onto the profile, so revoking a verification removes the tick
from every answer at once instead of leaving verified-looking content behind.

**Guards live in the migration that creates the table, not in `9999_guards.sql`.** That
file is already recorded in `_migrations` in every existing database, so edits to it
reach a fresh database and nothing else. The `A` prefix exists for amending a guard 9999
already defines; a new table's guards amend nothing and ship with the table.

**The panjika enum is now the blocker.** `packages/region/src/types.ts` already says
`panjika_school` should become a reference table before city three. Community adds
posts, events and knowledge items that all want to reference an almanac, and a national
rollout adds almanacs faster than it adds cities. Do the migration before C2, not after
three regions hold production rows pointing at it.

**A second engineer can work here without learning the ledger.** That is the practical
benefit of the boundary and the reason it is worth the indirection while the team is
two people.

## Alternatives considered

**One `posts` table serving forum, events and knowledge.** Rejected. Knowledge items are
curated, translated, versioned, cited and SEO-indexed — structurally closer to `rituals`
+ `ritual_translations` than to a thread. Merging them grows an editorial workflow onto
a table that also has to serve a conversational feed.

**Reuse `locale` and add the missing values with `ALTER TYPE`.** Rejected. It conflates
"languages we have translated the app into" with "languages people speak", and the first
list is a capability we control while the second is a fact about India. Merging them
means every language picker in the product starts offering Malayalam.

**A separate service or database.** Rejected as premature. ADR 0001 chose a modular
monolith and nothing here changes that calculus; folder boundaries and a capability seam
give the isolation that matters, and a second deployable gives a second on-call rotation
for a team that does not have a first.
