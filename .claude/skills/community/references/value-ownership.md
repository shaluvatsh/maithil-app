# Value ownership — where every number and string lives

The rule from `SKILL.md` Law 2, expanded into a registry you can check a change against.

## Why "no hardcoded values" needs a decision rule

Taken literally it produces worse code than it prevents: every constant becomes an env
var, `loadConfig()` grows to two hundred keys, and nobody can tell which ones are safe
to change. The useful formulation is narrower:

> **A literal is a bug when it is duplicated, or when it varies along an axis the code
> pretends it does not vary along.**

The axes that matter here are **city, language, almanac, tradition, deployment and
time**. A number that varies along none of them, appears once, and carries a comment
explaining its value is finished code. `const EARTH_KM = 6371` is correct. So is
`PRIOR_WEIGHT = 10` in the search ranking, because the comment next to it says what it
means and there is exactly one of it.

## The registry

### Tier 1 — `packages/region` · varies by city, language or almanac

Already modelled on `Region` in `packages/region/src/types.ts`. Community must read
these, never restate them.

| Value | Field | Community use |
|---|---|---|
| Slot definitions and **count** | `region.slots` | Event session templates. Never `4`, never `max(3)`, never a fixed label array — the south uses five |
| Timezone / UTC offset | `region.timezone`, `region.utcOffsetMinutes` | Every event `startAt`. Never `'Asia/Kolkata'`, never `330`. Nepal is +05:45 |
| Locales, primary first | `region.locales` | Default composer language, feed language filter. Never `'bn'` |
| Script | `region.script` | Font subset — **but see the per-item caveat in `scale-and-performance.md`** |
| Numerals | `region.numerals` | Counts in UI: `৮৪ জন যাচ্ছেন`. Never `toLocaleString('en-IN')` |
| Panjikas + default | `region.panjikas`, `region.defaultPanjika` | Tithi label on an event, panjika filter on a question |
| Coordinates | `region.coords` | Fallback centre for "near me" when the device declines |
| Travel gap / speed | `region.travelGapMinutes`, `region.avgSpeedKmph` | Only if an event ever affects purohit availability |
| Price index | `region.priceIndexBps` | Ticketed event price bands |
| Ritual set | `region.ritualSet` | Which vidhi variant a ritual guide describes |

**Adding a community-specific regional value?** Extend `Region` and give the factory a
default, exactly as `avgSpeedKmph` was added. A new city must stay "a handful of lines".
Do not create a parallel `COMMUNITY_CITY_CONFIG` map — that is the second source of
truth this package exists to prevent.

Candidates worth adding when C2 lands:
- `eventRadiusKmDefault` — 5 km in Mumbai is a neighbourhood, in Varanasi it is the city
- `festivalSet` — which festivals produce auto-generated C0 cards here

### Tier 2 — `packages/contracts` · the API and the web app must agree

| Value | Why here |
|---|---|
| `postKind`, `eventKind`, `registrationState`, `communityScope` enums | Both sides switch on them |
| Cursor encode/decode | The web app builds the next-page request; one implementation only |
| Page-size bounds (min/default/max) | The client sends it, the server clamps it. Two copies drift |
| Seat/ticket limits per registration | Rendered as a stepper, enforced as a constraint |
| Body length limits, title length | The composer disables the button; the API rejects. Same number |
| Event and post state machines | Same reason `state-machine.ts` already exists for bookings |

### Tier 3 — env via `loadConfig()` · varies by deployment, or must change without a deploy

Add to the zod schema in `apps/api/src/common/config.ts` **with a `.default()`**, so an
unset variable changes nothing — the `DB_POOL_MAX` precedent.

```
COMMUNITY_FEED_PAGE_SIZE          default 20
COMMUNITY_EVENT_RADIUS_KM_MAX     default 50
COMMUNITY_HOLD_TTL_SECONDS        default 600     # seat hold during payment
COMMUNITY_FREE_EVENT_OVERBOOK_BPS default 12000   # 1.2x; free RSVP no-shows are 40-60%
COMMUNITY_TRIAGE_ENABLED          default true
COMMUNITY_GRIEVANCE_ACK_HOURS     default 24      # IT Rules 2021
COMMUNITY_GRIEVANCE_RESOLVE_DAYS  default 15
```

`LAUNCH_CITY_SLUG` already exists. **Read it from `config`, not from `process.env`.**
Five call sites currently spell `process.env.LAUNCH_CITY_SLUG ?? 'kolkata'` inline
(`search.controller.ts`, `panchang.controller.ts` ×3, `verification.controller.ts`,
`seed/index.ts`) — five copies of one default, each able to drift, none validated by the
zod schema that exists to validate it. Do not add a sixth from community code.

### Tier 4 — the database · operational data that ops change without an engineer

| Table | Why not code |
|---|---|
| `community_spaces` | Ops open a space for Chhath or Pongal without a deploy |
| `moderation_terms` | The prohibited lexicon, **per locale and per script**. A slur list in a TypeScript array means a deploy during an incident |
| `event_venues` / temple directory | Third-party data with its own refresh cycle — same reasoning as `pincode_centroids` |
| `knowledge_items` + translations | Content, obviously |
| Moderation SLA per city | If it ever differs |

### Tier 5 — a named const at one call site

Allowed, and better than the alternatives, when the value varies along none of the axes.
Requirements: named, `const`, **commented with why that value**, and appearing exactly
once. The ranking weights in `search.service.ts` are the model to copy — the comment
explains why `experience` is 0.10 and where the 0.10 was taken from.

## Banned literals in community code

Anything in this list is a gate failure. The gate derives the city and panjika lists
from `packages/region` at runtime, so it extends itself when a city is added.

| Pattern | Use instead |
|---|---|
| Any city slug (`'kolkata'`, `'mumbai'`, …) | `config.launchCitySlug`, or the request's city |
| `'Asia/Kolkata'`, `330`, `5.5` as an offset | `region.timezone`, `region.utcOffsetMinutes` |
| `'en-IN'`, `'bn-IN'`, `₹`, `'INR'` in a formatter | `format.ts` in `packages/region` |
| Any locale code as a default or comparison | `region.locales[0]`, or the row's `locale` |
| Any panjika id (`'gupta_press'`, …) | `region.defaultPanjika`, or the row's snapshot |
| `4` as a slot count, `[0,1,2,3]` | `region.slots.length`, `region.slots` |
| A literal page size, radius, TTL, cap, SLA | Tier 2 or Tier 3 |
| An inline array of banned words | `moderation_terms` (Tier 4) |
| `process.env.X ?? 'literal'` | `config.x`, with the default in the zod schema |
| A WhatsApp template key as a string | The template registry — and see the notifications rule: community does **not** send WhatsApp |

## Gate failures that are not bugs

The script is a heuristic. Three legitimate cases, each of which needs a one-line
`// no-hardcode: <reason>` comment on the offending line to suppress:

1. **Migrations.** `0009_repoint_panchang_schools.sql` names `'kolkata'` because it is a
   historical record of a data fix. Migrations are excluded by default.
2. **Seeds and fixtures.** `harness.ts` and `seed/dev.ts` construct a specific city on
   purpose. Excluded by default.
3. **The region package itself.** It is the owner. Excluded by default.

If you find yourself suppressing more than once in a change, the value has an owner and
you have not found it yet.
