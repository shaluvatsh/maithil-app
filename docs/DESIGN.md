# The Maithil — design direction

Written as the design brief the build follows. 8 August 2026.

---

## The strategic problem

Look at the category honestly. SmartPuja, 99Pandit, Harivara, BookMyPooja, Tathastu all
share one visual language: **saffron-to-orange gradients, marigold and diya stock
photography, emoji as interface, and a wall of unverifiable numbers** — "20,000+ pandits",
"5,00,000+ pujas", "4.9★". Tathastu's landing page literally uses 🪔🙏✅ as UI furniture.

That language communicates *volume and convenience*. Every one of them sells the same
promise: **"hassle-free"**.

Two consequences:

1. **You cannot out-shout them.** They have a decade of SEO, bigger claimed supply, and
   more cities. Competing on abundance is competing on their strongest ground.
2. **Nobody in this category looks trustworthy to a discerning buyer.** The signals they
   use — huge round numbers, badge spam, urgency — are the signals of a category that
   expects to be doubted. A Kolkata family spending ₹15,000 on their daughter's Upanayan
   is not reassured by "20,000+ pandits". They are reassured by evidence that you know
   what you are doing.

## The positioning that follows

**The category sells convenience. We sell correctness.**

Premium in ritual is not luxury. It is *rightness* — the confidence that nothing will be
wrong on the day, that the date is right by *your* family's panjika, that the purohit knows
your tradition. That is a completely different design problem from "hassle-free", and it
has a completely different visual answer.

Everything below follows from one line:

> **Specificity is the premium signal. We are the only ones who can be specific.**

"Tithi ends 3:47 pm" beats "600+ pujas". "গুপ্তপ্রেস বলছে শুভ, বিশুদ্ধসিদ্ধান্ত বলছে না" beats a
verified badge. "₹255 now, ₹2,340 cash on the day" beats "best price guaranteed". None of
it is copyable without the data — and no competitor has the data.

---

## Five design principles

### 1. Restraint as authority
In a category that shouts, the quiet confident one reads as the expensive one. Generous
whitespace, one accent colour used sparingly, no gradients, near-invisible shadows, small
corner radii. The visual budget goes into typography and precision, not decoration.

### 2. The almanac, not the temple
Every competitor reaches for temple imagery. We reach for **the printed panjika itself** —
red and black on newsprint, dense typographic tables, ruled columns, marginal glyphs. It
is authentically Bengali, it is what a Kolkata household actually keeps on a shelf, it is
ownable, and it costs nothing in photography budget.

This is the single highest-leverage art-direction decision available: it makes the product
look like an authority rather than a listing site.

### 3. Show the seam
Where the two panjikas disagree, say so. Where our astronomy is accurate to tens of
minutes rather than seconds, say so. Where the price splits between online and cash, show
both lines. **Admitting a limit is the strongest trust signal available**, it is what a
real purohit does, and a competitor without the underlying data cannot imitate it.

### 4. The purohit is a person
Not inventory, not a badge count. Name, photo, years, lineage, languages, the traditions
they serve. Supply is the moat; the design should treat purohits as the reason to trust the
platform, not as a fungible resource behind a "verified" tick.

### 5. Match on vidhi, never on ethnicity
Most purohits working in Kolkata are Maithil Brahmins, and they serve Bengali, Marwari,
Bihari and Maithil households alike. "Bengali purohit" is therefore both inaccurate about
the supply and a promise we would routinely break. The devotee-facing claim is
**"performs your family's vidhi, speaks your language"** — which is what the household
actually cares about, and what the data model already stores.

The brand carries the lineage; the interface carries the competence.

### 6. Bengali is the first language, not a localisation
Bengali sets first and sets larger. Bengali numerals in the purohit app. A real Bengali
typeface, optically matched to the Latin — most Indian sites fall back to system Bengali,
which reads to a Bengali speaker roughly the way Comic Sans reads in English. Getting this
right is invisible when done and glaring when not.

---

## Colour

Evolved from the prototype palette rather than replaced — the terracotta lineage stays,
because it is right. **The saturated gold goes**, because `#E8A33D` is the category's
saffron and it is what makes these sites read cheap.

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#1A1512` | Text, headings. Warm near-black, never pure `#000` |
| `--ink-soft` | `#6B5D52` | Secondary text |
| `--alta` | `#9C3D2E` | **The one accent.** Primary action, auspicious marks, panjika rules |
| `--alta-deep` | `#5C1F16` | Hover, dark surfaces |
| `--paper` | `#FBF7F1` | Page. Unbleached, never white |
| `--paper-2` | `#F2E9DC` | Raised surfaces, table stripes |
| `--rule` | `#E0D3C0` | 1px borders. Doing the work shadows would do |
| `--brass` | `#A8834B` | Rare accent — badges, muted metal. Not gold |
| `--moss` | `#4A5D45` | "Auspicious" / positive. Not success-green |
| `--clay` | `#8A5A3B` | "Avoid" / caution. Not warning-amber |

**Discipline:** `--alta` appears at most twice per screen. The moment a third alta element
appears, the page starts to look like everyone else's.

## Typography

The place premium is won.

| Role | Face | Why |
|---|---|---|
| Display, Latin | **Fraunces** | Old-style, high contrast, variable optical size. Reads as considered and slightly bookish rather than startup-generic |
| Display, Bengali | **Noto Serif Bengali** | Real serif with proper weight range. The category's default fallback has none |
| UI, Bengali | **Anek Bangla** | Variable, purpose-designed for interface. Excellent at small sizes |
| UI, Latin | **Inter** | Neutral, gets out of the way |
| Numerals | Any of the above with `font-variant-numeric: tabular-nums` | Money must align in columns. Always |

**Optical matching:** Bengali glyphs need roughly 1.06–1.10× the Latin size to feel the
same weight, and more line-height. Set via `size-adjust` on the font-face and a
`:lang(bn)` rule. This is the detail nobody in the category gets right.

**Minimum body size 16px, Bengali 17px.** Bengali conjuncts collapse below that.

## Space, shape, motion

- **4px base.** Section rhythm 24 / 32 / 48 / 64 / 96. Premium is whitespace.
- **Radius 6px** — small. Large radii read consumer-app; small radii read print.
- **Shadows: essentially none.** One 1px `--rule` border does the job. Elevation is
  communicated by paper tone, as in print.
- **Motion 150–200ms `ease-out`, opacity and 2–4px translate only.** No parallax, no
  scroll-jacking, no reveal animations.

---

## Trust patterns — the specific UI moves

These are the design, more than the palette is.

**The panjika question as a first-run moment.** Not a settings toggle. Full-screen, in
Bengali: *আপনার পরিবার কোন পঞ্জিকা মানে?* — with all three almanac names (Gupta Press,
Bisuddha Siddhanta, Mithila Panchang), a one-line explanation of each, and "not sure, show
me both" as an honourable default. This is the
first thing that tells a Kolkata user the product was built for them and not adapted for
them.

**Surface the disagreement.** When the two schools differ on a date, show both verdicts
side by side. Never resolve it silently.

**The bill, always itemised, never a package price.** Dakshina, samagri at BOM cost plus
the 5% sourcing line, travel, platform fee, surge if any — then the split: *pay now* and
*cash on the day*. Competitors show one number because they are a principal selling a
package. Showing the breakdown is a structural advantage; use it.

**Pre-commit to the bad case, on the booking screen.** What happens if the purohit
cancels; what the refund is at 48h, 24h, and inside 24h; who to call. Stated plainly
before payment, not buried in terms. Trust is built by how you describe failure.

**The OTP framed as protection, not admin.** "Give this code to the purohit when the puja
is done — it confirms the ritual and the exact cash amount, so nothing is negotiated at
your door."

**Numbers that are true.** If there are 30 purohits, say 30. A specific small number in a
category of inflated round ones is a credibility asset, not a weakness.

## Anti-patterns — banned, with reasons

| Never | Because |
|---|---|
| Saffron/orange gradient hero | The category default. Instantly indistinguishable |
| Emoji as interface | Tathastu does this. It reads as a landing-page template |
| "20,000+ pandits" style claims | Unverifiable round numbers signal a category that expects doubt |
| Stock diyas, marigolds, folded hands | Every competitor. Use typography or line illustration instead |
| Countdown timers, urgency banners | Corrosive to trust in a ritual context |
| Autoplay video, chat popups | — |
| "As seen in" logo wall as primary proof | Borrowed credibility. Earn it with specificity |
| Pure white `#FFF` or pure black `#000` | Reads clinical. Paper and ink are warm |
| A "verified" tick with nothing behind it | Show what was verified instead |

---

## Per-surface direction

**Marketing home.** One clear proposition, the panjika moment early, three purohits shown
as people, an honest number. Typographic hero — no photograph. Short.

**Booking flow.** The panjika strip sits above the slot picker so the auspicious day and
the bookable slot are visible together — that adjacency *is* the product, and it is the one
thing no competitor can render. Abhijit marked on the slot that contains it; Rahu Kaal
shown and never blocked, because the choice stays with the devotee.

**Purohit app.** A different design problem, not a restyle. Users are 30–65, on low-end
Android, sometimes outdoors, often one-handed, Bengali-only. Larger type, higher contrast,
Bengali numerals on, fewer choices per screen, and the earning figure as the largest
element on the page.

**Admin.** Density over beauty. Tables, keyboard-first, no decoration. The ledger view
should look like a ledger.

---

## What to build first

1. Tokens and the two font pairings, with the Bengali optical match
2. The panjika first-run moment — highest trust-per-pixel in the product
3. The itemised bill component
4. The panchang strip bound to the slot picker
5. Marketing home, typographic, no stock photography

Everything else can stay plain for now. These five carry the positioning.
