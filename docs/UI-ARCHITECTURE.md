# UI architecture — one system, many cities

How the interface is put together, and what it takes to launch a new city.
8 August 2026.

---

## The problem this solves

"Pan-India configurable" is not a CSS problem. Before this change, Kolkata was hardcoded
in nine places across the backend and frontend: coordinates for the panchang, a literal
`+05:30`, Bengali month names, a fixed four-slot day, `citySlug: 'kolkata'` in three
controllers, Bengali fonts in the stylesheet, and Bengali strings inline in JSX.

Launching Patna would have been a codebase-wide search for the word "kolkata". Launching
Bengaluru would have been worse, because it needs five slots a day and a different script.

**The fix is a region model: everything that varies between cities is data.**

---

## The layers

```
packages/region          framework-agnostic, dependency-free
  types.ts               the Region shape
  regions/*.ts           kolkata · patna · bengaluru
  fonts.ts               script → font plan → which webfonts to fetch
  format.ts              money, time, dates, era dates, numerals, slot instants
  i18n/                  typed dictionaries + fallback chain

apps/web
  lib/region-context.tsx RegionProvider — supplies region, locale, translator, formatters
  components/ui.tsx      primitives: Button Tag Card Notice Stat Steps Field
  components/domain.tsx  Bill · SlotPicker · PanchangStrip · PurohitCard
  app/globals.css        layered tokens; native-script vars injected per region

apps/api                 reads the same package for coordinates, offsets, slots,
                         calendar system and which almanacs are computable
```

`packages/region` has **no dependencies and no framework**. That is deliberate — the API
imports it in Node, the web app imports it in React, and the two React Native apps will
import the same objects when they exist. One source of truth for what a city *is*.

## What a Region declares

| Field | Why it cannot be a constant |
|---|---|
| `coords` | Sunrise moves ~4 minutes per degree of longitude. Panchang is wrong without it |
| `utcOffsetMinutes` | India is +05:30 today; Nepal is +05:45 and is a plausible market |
| `locales` + `script` | Drives which webfonts are fetched — see performance below |
| `numerals` | Bengali households expect ০-৯ in the purohit app |
| `panjikas[]` | Kolkata keeps three almanacs, Patna two others, Bengaluru two others again. Each declares its `calendar` and whether it is `computable` |
| `slots[]` | Kolkata has four 3-hour blocks. Bengaluru needs **five**, opening at brahma muhurta |
| `travelGapMinutes` | 30 minutes works in Kolkata. Bengaluru traffic needs 60 |
| `ritualSet` | The catalogue and BOM tradition variant to seed |
| `era` | Bangabda in Kolkata, Vikram Samvat in Patna, none in Bengaluru |

Bengaluru exists in the config specifically as a **stress test**: different script,
different slot count, different travel gap, no era calendar. If the model survives it, it
survives most of India.

## Performance: the font decision

The single biggest performance choice in a pan-India product. Indic webfonts are large,
and naively loading every script would add hundreds of kilobytes of render-blocking font
data to every page.

`fontPlan(script)` returns only the faces that region needs, and `app/layout.tsx` builds
the stylesheet URL from it. **A Bengaluru user never downloads a Bengali face.** Latin
faces are constant because the brand is constant; only the Indic pair swaps.

The plan also carries `opticalScale` — Indic glyphs are optically smaller than Latin at
the same point size, and the correction differs by script (Tamil 1.12, Gujarati 1.06).
Without it the two scripts look like different weights side by side, which is the tell
that a site was designed in English and translated afterwards.

## i18n

Typed dictionaries with a fallback chain: requested locale → region's locale order →
English. A missing translation degrades to readable English rather than shipping
`bill.dakshina` to a devotee, which is how most Indian apps leak keys into production.

`MessageKey` is derived from the English catalogue, so `t('bill.dakshnia')` is a compile
error.

## Config validation as a test

`packages/region/src/__tests__/regions.test.ts` runs over **every** region and asserts:

- slot indices are contiguous from zero, ordered, non-overlapping, and never negative-gap
- the default panjika is one the region actually offers
- the era, if declared, has twelve months
- every message key resolves through the locale chain, and every slot has a label
- the font plan resolves and money formats

A fourth city is covered the moment it is added. A malformed config fails at build time
instead of shipping a broken slot picker to a new market.

---

## Launching a new city

1. **Add `packages/region/src/regions/<slug>.ts`** and export it from `index.ts`.
   The config test will immediately tell you what is inconsistent.
2. **Add the locale dictionary** if the region introduces a new language.
   Missing keys fall back to English; the test lists them.
3. **Seed** — `cities`, `slot_defs` from `region.slots`, the ritual set for
   `region.ritualSet`, and BOMs with the right `boms.tradition`.
4. **Set `LAUNCH_CITY_SLUG`** (API) and `NEXT_PUBLIC_REGION` (web).
5. **Hand-enter the non-computable panjikas** for the year, and have the local purohit
   sign them off.

No code changes. Steps 3 and 5 are content work, and step 5 is the one that actually
gates a launch.

## The one schema change to make before city three

`panjika_school` is a Postgres enum. Fine for three values, a liability past about six:
`ALTER TYPE` can add but never remove or reorder, and every city that brings its own
almanac needs a migration coordinated with a deploy.

**Convert it to a reference table before the third city.** It is cheap now and expensive
once there is production data in three regions. Flagged here rather than in a backlog
because the trigger is knowable in advance.

## Known gaps

- **Purnimant months are not implemented.** Tithi and nakshatra are angular and compute
  correctly for any calendar, but month *naming* under the purnimant system is not
  written — so Mithila and Banaras panjikas stay hand-entered. This is the main blocker
  on a Patna launch.
- **The purohit app is still a restyle, not a redesign.** Its audience is 30–65, on
  low-end Android, often one-handed and outdoors. It needs larger type, higher contrast,
  local numerals on by default and fewer choices per screen. The tokens support this; the
  screens have not been reworked.
- **`components/` lives in `apps/web`.** Correct for now. When the React Native apps
  arrive, tokens and the domain component *prop surface* should move to a shared
  `packages/ui` with per-platform renderers. The region package is already positioned for
  that; the web components are not.
