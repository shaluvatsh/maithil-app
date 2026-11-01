# ADR 0017 — English is the default language; the reader chooses

Status: accepted, 19 September 2026.
Amends ADR 0009 (i18n). Supersedes the "Bengali-first" default, not the i18n machinery.

---

## Context

The product opened in the first language of whichever city the visitor was in.
`RegionProvider` did `const locale = region.locales[0]`, so Kolkata rendered in
Bengali, Chennai would have rendered in Tamil if a Tamil dictionary existed, and the
README described the product as "Bengali-first".

The reasoning was sound as far as it went: Kolkata speaks Bengali, a Bengali household
should not have to ask for Bengali, and every competitor ships an English-only app to
a market that does not read English first.

It confuses a fact about a **city** with a fact about a **visitor**.

`region.locales` says which languages are spoken in a city. It does not say which one
a given person reads most comfortably. Kolkata contains Bengali, Hindi, English,
Maithili and Odia households; it has a large migrant population; and it contains a
great many people who speak Bengali fluently but read English faster, because English
is the script they were schooled in. The same is true of every other city on the list.

So the old default served one group well and quietly taxed everyone else — and it did
so on first paint, before the visitor had any way to say otherwise. A devotee who
cannot read the page they landed on does not go looking for a language switcher; they
leave. The cost of being wrong is asymmetric and it was being paid silently.

There is a second, narrower problem. `availableLocales(region)` returned the region's
locales intersected with the dictionaries that exist. For Chennai that is English and
nothing else, so a Bengali family living in Chennai had no way to read the app in
Bengali — although the translation exists, and they are exactly the household it helps
most.

## Decision

**English is the default interface language in every city, and the reader can change
it in one tap from the header.**

- `DEFAULT_LOCALE = 'en'` in `packages/region/src/i18n`. One owner, no per-city
  variation, and the app opens in it everywhere.
- The choice is a **separate stored preference** from the city
  (`themaithil.locale` beside `themaithil.city`). Two preferences, because they are
  two different facts: where the ceremony happens, and what the reader reads.
  Inferring either from the other is the bug being fixed.
- **`region.locales` is untouched** and still means what it meant. It orders the
  language picker, drives the languages a purohit may claim, and backs the search
  filter. It no longer decides what the interface opens in.
- The picker offers **every language the product is translated into**, with the
  region's own first — not the region's list intersected with the dictionaries.
- Every option is labelled **in its own script** (বাংলা, हिन्दी), never "Bengali" in
  Latin. Someone who needs this control is by definition someone for whom the English
  label is the harder one to read.
- **The reader is offered the local language once, on their first visit**, in that
  language — a dismissible strip under the header reading বাংলায় পড়ুন, not a globe
  icon. Afterwards the control lives in the footer. See the amendment below.
- **Digits follow the language, not the city.** `NUMERALS_FOR_LOCALE` is keyed by
  locale, so the app in English in Kolkata shows "84" and the app in Bengali in
  Bengaluru shows "৮৪". `Region.numerals` remains the city default for anything
  formatted without a reader present — server-side output, a purohit-facing document,
  a page with no session.

**What does not change: content is still rendered in the language it was written in.**
The community surface typesets a Bengali question in Bengali and a Tamil one in Tamil,
per item, whatever the chrome is set to. The chrome being English does not make the
content English, and that distinction is the whole point of having separate UI and
content locales (ADR 0014).

## Consequences

**The switcher is load-bearing and must stay reachable.** English-by-default is only
defensible if the reader who cannot read English is actually reached. That is the
constraint; a header control was the first attempt at meeting it and not the only way.
See the amendment below.

**Bengali and Hindi translations matter more, not less.** The default changing does not
reduce the value of the dictionaries; it means they are reached by choice rather than
by geography, so gaps are now visible as a language someone selected and did not get.
`MessageKey` is still derived from the English catalogue, so a missing key is still a
compile error.

**The README's "Bengali-first" framing is wrong and has been corrected.** The product
is multilingual with an English default, which is a different claim.

**`search.controller.ts` returned a literal `locale: 'bn'`** on every result set,
telling a Chennai client its results were Bengali. Now `DEFAULT_LOCALE`. It was wrong
before this decision and would have gone on being wrong after it.

**A future locale needs three things before it can be offered**: a dictionary, an entry
in `NUMERALS_FOR_LOCALE`, and an entry in `SCRIPT_FOR_LOCALE`. All three are
`Record<Locale, …>`, so adding a locale to `types.ts` is a compile error until they
exist — which is the intended guard.

**Detecting language from the browser was considered and deferred.** `Accept-Language`
is a reasonable signal, but it is wrong often enough in India — a phone set to English
in a Bengali-reading household is extremely common — that it would reintroduce the same
silent mis-default with a more complicated explanation. An explicit, persisted choice
is worth more than a clever guess. Revisit with evidence from real switch rates.

## Alternatives considered

**Keep the city default and add a switcher.** Rejected. It keeps the tax on everyone
the city's first language does not fit and only refunds it to the people who notice a
control and use it — which is the group least in need of help.

**Ask on first run, like the panjika question.** Rejected for now. The panjika prompt
earns its interruption because the answer changes which dates we call auspicious and
there is no safe default. Language has a safe default, and a second modal before a
visitor has seen anything costs more than it returns. Worth revisiting if switch rates
turn out to be high.

**Detect from the city and offer a banner** ("Read this in বাংলা?"). Not rejected —
deferred. It is a good middle path once there is data on who switches, and it composes
with this decision rather than replacing it.

---

## Amendment, 19 September 2026 — the control moved out of the header

**What changed.** The language picker was placed in the top bar on the reasoning above:
if the app opens in English, changing it must be one tap away. Shipped and looked at, it
was wrong in the header.

**Why.** Almost nobody changes language twice. A control in the top bar is permanent
chrome on every screen, forever, for an action performed once in a lifetime — and on a
phone it collapsed to a bare globe sitting next to the city pill, which *is* used
repeatedly. It cost the most valuable space in the product to serve its rarest action,
and it crowded the control beside it.

**What replaced it**, and why this is better rather than merely tidier:

- **A one-time offer**, under the header on a first visit, written in the language it
  is offering — বাংলায় পড়ুন, with the accept button reading বাংলা. It speaks first, so
  the reader does not have to notice an icon and open a menu to discover the app has
  their language. It is shown at most once: `localeChosen` suppresses it for anyone who
  has decided, and dismissal is remembered, because a banner that returns is worse than
  no banner. It is not a modal — the majority who are happy in English must not be
  blocked by it.
- **The picker in the footer**, where a language control conventionally lives:
  permanent, reachable from every page, costing nothing on any of them.

A banner in English offering Bengali would have been the same mistake as the icon, one
step quieter. Asking in the offered language is the part that does the work.

**What this does not change.** English is still the default in every city, the choice is
still stored separately from the city, digits still follow the language, and content is
still rendered in the language it was written in. Only the placement of the control
changed — and with it the claim, now removed, that the header was the thing making
English-by-default defensible.
