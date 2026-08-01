# ADR 0003 — Panchang must be dual-school in Kolkata

Status: Accepted · 31 Jul 2026
**This is the most consequential decision in the R1 design and it is absent from both source documents.**

## Context

Both the PRD and the architecture handoff model panchang as a single source of truth:
one licensed API, one `panchang_days` row per city per date, one `tithi` value.

That model is wrong for Bengal.

Bengal has **two competing panjika traditions that publish different dates for the same
festival**:

| School | Almanacs | Basis | Followers |
|---|---|---|---|
| **Drik Siddhanta** | Bisuddha Siddhanta Panjika | 1890 amendment of planetary positions; astronomically observed | Ramakrishna Mission / Belur Math, and families who follow them |
| **Surya Siddhanta** ("Odrik") | Gupta Press Panjika, P.M. Bagchi | ~1,500-year-old treatise; traditional | The larger mass market, most para/community pujas |

In 2005 the two schools produced two different date sets for Durga Puja. Belur Math observed
one; many community pujas observed the other. This is not an edge case — it is the single most
visible thing a Bengali family checks before booking a purohit, and getting it wrong is not a
bug report, it is a lost customer who tells their family.

Compounding this: **Prokerala's API supports only `ayanamsa=1`** (Lahiri/Drik), so it can
serve Bisuddha Siddhanta and *cannot* produce Gupta Press dates. It also has no Bengali
localisation (Hindi, Tamil, Telugu, Malayalam only), so every tithi and nakshatra name has to
be translated in-house anyway.

## Decision

**1. `school` is a first-class dimension on every panchang table**, not a config flag.
`panchang_days`, `panchang_intervals` and `muhurat_flags` are all keyed by
`(city_id, school, date)`. `school ENUM('bisuddha_siddhanta','gupta_press')`.

**2. Panchang is stored as intervals, not day values.** Tithis transition at arbitrary clock
times and a day commonly spans two. `panchang_intervals(kind, value_key, starts_at, ends_at)`
holds the truth; `panchang_days` caches the conventional at-sunrise collapse for the devotee
view. The pandit view shows the transition time, because a purohit will check.

**3. Sourcing is hybrid, and deliberately so:**
- **Bisuddha Siddhanta** — from the Drik/Lahiri API (Prokerala tier at ₹999/mo). Our
  precompute design makes this ~120 API calls per month for one city. Cost is a rounding error.
- **Gupta Press** — **hand-entered once a year** from the printed panjika into
  `muhurat_flags` and a festival-date table, via an admin screen, verified by the consulting
  purohit. Roughly 40 festival dates and ~30 muhurat windows: about two hours of data entry
  annually. No vendor, no contract, no integration risk.

This is the whole point of the decision. The alternative — sourcing Gupta Press from a
licensed feed — means a bespoke commercial conversation with a 150-year-old family press that
does not sell an API. Hand entry removes a hard external dependency from the critical path for
the cost of an afternoon.

**4. The devotee picks their school once, at signup**, phrased in the language families
actually use — *"Which panjika does your family follow?"* with the almanac names and a
"not sure / show me both" default. Stored on `users.panjika_school`, snapshotted onto
`bookings.panjika_school` so a later preference change never rewrites history.

**5. Where the two schools disagree on a date, the UI says so** rather than picking a winner.
This is a trust asset, not an inconvenience: no competitor surfaces the disagreement, and
showing it is the single clearest signal that we know what we are doing.

## Consequences

- Storage doubles. It is a few thousand rows. Irrelevant.
- The nightly materialisation job runs per (city × school).
- Search and availability annotation must carry the school through, since "is this an
  auspicious day for Griha Prabesh" has two answers.
- **The consulting purohit becomes a named, paid, recurring role**, not a one-off review — they
  own the annual Gupta Press entry and sign off the Bengali term translations. Budget for this
  in Phase 0. They are also the only person who can validate the 25 BOMs.
- `Drik Panchang` (the website named in the handoff) publishes no commercial API. Treat it as
  a bespoke conversation that may not exist as a product, and do not let it block P1-3.

## Rejected

- **Single school with a config switch** — makes the wrong half of Kolkata wrong.
- **Hand-rolled Swiss Ephemeris for both** — the Drik half is solvable this way, but the
  Gupta Press half needs the Surya Siddhanta algorithms *as the press actually applies them*,
  including their own corrections. Reproducing that without the press's own tables is a
  research project, not a sprint.
