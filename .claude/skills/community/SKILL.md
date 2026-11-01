---
name: community
description: Design and build The Maithil's community surface — forum/Q&A, nearby religious events with prior seat booking, and the knowledge library — pan-India and scalable from the first commit, with no city-, language- or deployment-specific value hardcoded. Use when adding, reviewing or extending anything under community, events, knowledge/learning, feeds, discovery, moderation or user-generated content; or when a change must be proven free of hardcoded values.
---

# Community — the design and development contract

`CONTRIBUTING.md` comes first. **Read its "Standing constraint" and "Multi-city rules"
sections before writing anything here.** This file does not restate them — it is a
pointer plus the part they do not cover, which is that the community surface breaks
three assumptions every existing module is allowed to make:

| Every other surface | The community surface |
|---|---|
| One city per request. `getRegion(citySlug)` resolves once and everything downstream inherits it | A feed mixes cities, scripts, numerals and panjikas **in one list**. There is no single region for the response |
| Renders content the platform authored and translated | Renders content a stranger authored, in a language nobody on the team reads |
| Tables grow with bookings — thousands | Tables grow with reads and impressions — millions, and they never shrink |

Everything below follows from those three rows.

---

## The three laws

### Law 1 — Every community row is region-scoped, and scope is explicit

No community entity may exist without answering "who is this for?". That answer is a
column, never an inference from the author's city.

```ts
/** city | state | national. A Durga Puja in Kolkata is noise in Chennai. */
scope:     communityScopeEnum('scope').notNull(),
cityId:    text('city_id').references(() => cities.id),   // required when scope='city'
stateCode: text('state_code'),                            // required when scope='state'
locale:    localeEnum('locale').notNull(),                // NEVER defaulted to 'bn'
```

Enforce the scope/column pairing with a `CHECK` in SQL, not in a service (step 3 says
which file).
A feed query that forgets the scope predicate is a national firehose, and it will look
fine in Kolkata-only dev data.

**Consequence most people miss:** a national feed carries Bengali, Tamil and Devanagari
in a single response, so `region.script` can no longer drive font loading on these
pages. `packages/region/src/types.ts` promises "a Chennai user must never fetch
Bengali" — on community surfaces that promise must be kept **per item**, from the
row's `locale`, not per region. See `references/scale-and-performance.md`.

### Law 2 — Every literal has exactly one owner

"No hardcoded values" does not mean "no literals". `EARTH_KM = 6371` is correct code.
An *unowned* literal is the bug: one that is duplicated, or that varies by city,
language, tradition or deployment and was written as though it does not.

Ask, in order, and stop at the first yes:

| Question | Owner | Examples |
|---|---|---|
| Does it vary by city, language or almanac? | `packages/region` | slot defs, locales, script, numerals, panjikas, `avgSpeedKmph`, `priceIndexBps`, `utcOffsetMinutes` |
| Must the API and the web app agree on it? | `packages/contracts` | state machines, enums, zod schemas, page-size bounds, seat limits, refund tiers |
| Must it change without a deploy? | env via `loadConfig()`, or a table | horizons, pool sizes, feature flags, moderation SLA, the prohibited-term lexicon |
| None of the above? | a named `const` at its single point of use, **with a comment saying why that number** | `PRIOR_WEIGHT`, `EARTH_KM`, ranking weights |

A literal that reaches a second file has lost its owner. Move it up a tier.

> **The worked example, from this repo.**
> [`availability.service.ts:13`](../../../apps/api/src/modules/availability/availability.service.ts) carries the
> comment *"Offsets come from region config, never a constant — India is +05:30 today
> but Nepal is +05:45, and hardcoding it is the kind of thing that only breaks in a new
> market."* Two lines later: `citySlug = 'kolkata'` as a default parameter. Every caller
> that omits the argument silently computes slot instants with Kolkata's rules.
>
> The rule was known, written down, and still broken — in the same function. Intent does
> not survive contact with a default value. That is why `scripts/no-hardcode.sh` exists.

Full owner registry, the banned-literal list, and the gate: `references/value-ownership.md`.

### Law 3 — Every list is keyset-paginated, counted from a column, and indexed for its predicate

`OFFSET` on a feed is O(offset) and degrades exactly as the feature succeeds.
`COUNT(*)` per row in a list is N+1 wearing a disguise. A btree on `(lat, lng)` cannot
serve a radius query — `CONTRIBUTING.md` already says so, and event discovery is a
radius query.

Three non-negotiables before any feed endpoint merges:

1. Cursor is `(sort_key, id)`, opaque and base64'd in `packages/contracts`. Never `page=3`.
2. Reaction and reply counts are columns maintained by trigger, never aggregated at read.
3. `EXPLAIN` the feed query against ≥100k rows and paste the plan in the PR. Measure
   before claiming — the standing constraint says so.

Details, index shapes and the geo pattern: `references/scale-and-performance.md`.

---

## Before you write code

1. **Name the owner of every value** in the change, using Law 2's table. Write it down
   in the PR description. Values with no owner do not get written.
2. **Draw the schema first**, in `apps/api/src/db/schema/community.ts` — a new bounded
   context, no foreign keys pointing *into* booking. ADR 0014 should say it must remain
   deletable. Schema conventions: `references/data-model.md`.
3. **Write the guard SQL in the same change, in the migration that creates the table.**
   Scope pairing, one-level nesting, `published ⇒ reviewedBy`, `seats_taken <= capacity`.
   Invariants go in SQL because an ORM bug or a psql session must not be able to
   corrupt them — community's equivalent of the ledger invariant is capacity.

   **Not in `9999_guards.sql`.** That file is already recorded in `_migrations` in
   every existing database, so edits to it apply to a FRESH database and to nothing
   else, and the drift stays invisible until a production write does something no
   test could. The `A` prefix (`A0001_long_rituals.sql`) exists for AMENDING a guard
   9999 already defines, and sorts after it because `'9' < 'A'`. A new table's guards
   amend nothing, so they ship in the table's own migration and a database has both
   or neither. `0026_community.sql` is the worked example.
4. **Contracts before controllers.** zod schemas in `packages/contracts/src/schemas/`
   so the web app and future mobile clients read one definition.
5. **Then the service, then the controller, then the page.**

## Build order

Ship in this sequence. Each release is independently valuable and each one's moderation
load is survivable by the team that exists.

| | Surface | Depends on |
|---|---|---|
| C0 | Panchang daily card + festival countdown, per panjika, per city. Zero UGC | region + panchang only |
| C1 | Ask a Purohit — Q&A, verified answers, peer endorsement | C0, identity split, reports queue |
| C2 | Events — listing, geo discovery, RSVP/seats, check-in | C1, capacity guards, ledger entry types |
| C3 | Knowledge library + open Circles | C1, review workflow, object store |

Do not start C2 before C1's moderation queue has run with real traffic for a month.

## Verification gate

`CONTRIBUTING.md`'s gate, plus this skill's:

```bash
pnpm typecheck && pnpm build && pnpm test          # exit code, never piped to tail
.claude/skills/community/scripts/no-hardcode.sh     # the Law 2 gate
```

Then the two checks no script can make for you:

- **Second-city test.** Re-run the flow with `LAUNCH_CITY_SLUG` set to a southern city
  (five slots, different script, different panjika). Anything that renders Kolkata's
  labels, Bengali numerals or four slots is a Law 1 or Law 2 break. `SOUTH_SLOTS` exists
  precisely so this test is cheap.
- **Second-instance test.** Would this background job corrupt itself on a second
  machine? Moderation triage and event reminders both need an advisory lock.

Promote `no-hardcode.sh` into `scripts/` and CI once it runs clean — `.claude/` is
deleted before production, and a gate that ships with the repo is a gate that survives.

## References

| File | Read it when |
|---|---|
| `references/value-ownership.md` | Deciding where a value lives; adding a banned literal; understanding a gate failure |
| `references/data-model.md` | Writing or reviewing community/event/knowledge schema |
| `references/scale-and-performance.md` | Writing a feed, a geo query, a counter, a search, or a background job |
| `scripts/no-hardcode.sh` | Every commit that touches community code |
