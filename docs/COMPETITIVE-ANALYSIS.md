# Competitive landscape — online puja & purohit booking

Analysis of eleven sites, fetched 7–8 August 2026. Claims marked *(claimed)* are the
companies' own marketing numbers and should be treated as unaudited.

---

## The single most important finding

**These eleven sites are not one market. They are three different businesses**, and only
five of them compete with The Maithil at all.

| Category | Who | What they actually sell | Field ops? |
|---|---|---|---|
| **A. At-home purohit marketplace** | SmartPuja, 99Pandit, Harivara, BookMyPooja, Tathastu Puja | A verified purohit arrives at your house | Heavy |
| **B. Temple-proxy devotion** | Utsav, Devaseva, YatraDham | A puja performed *on your behalf* at a temple, plus prasad by courier | None |
| **C. Temple/math booking SaaS** | MyPoojaBooking | Software sold to religious institutions to take their own seva bookings | None |

Category B is where the volume is. Utsav claims 10 lakh+ devotees, Devaseva 6 lakh+ sevas,
YatraDham 2M+ devotees — all far above any at-home player's claims. The reason is
structural: no purohit to dispatch, no travel, no samagri logistics, no scheduling,
national from day one, and an impulse price point.

**Category A — the business The Maithil is in — is the hardest and least scaled part of
this market.** That is worth sitting with. It may be the right hard problem, but nobody
should think it is the obvious one.

---

## Category A: the direct competitors

| | SmartPuja | 99Pandit | Harivara | BookMyPooja | Tathastu |
|---|---|---|---|---|---|
| Since | 2016 | ~2023 | 2016 | 2019 | 2015 |
| Purohits *(claimed)* | 2,000+ | 20,000+ | 5,000+ | 2,000+ | 30+ |
| Pujas done *(claimed)* | 75,000+ | 1 lakh+ | 5,00,000+ | 10,000+ | 15,000+ |
| Cities | 30 | ~95 pages | 13 | 10+ | 1 (Bangalore) |
| Rituals | — | 400+ | 600+ | 600+ | ~10 |
| Home base | Bengaluru (NSRCEL, IIM-B) | — | Chennai | Bengaluru | Bengaluru |
| Mobile apps | No | **Yes — user + partner, iOS + Android** | No | No | No |
| Tech | Custom | WordPress | WordPress (2016 Visual Composer) | Next.js | Static page |

Treat the supply numbers sceptically. 99Pandit claims **ten times** SmartPuja's purohit
count while claiming a similar booking volume; Harivara claims 5,00,000 pujas against
SmartPuja's 75,000 despite similar age and smaller footprint. These are SEO numbers.

**Note for the vision deck:** it cites the category leader at "85,000+ pujas" and "2,100+
verified pandits". SmartPuja's site today says **75,000+ and 2,000+**. The deck's figures
are either stale or rounded upward — worth correcting before anyone quotes them to an
investor.

---

## What nobody does — the gaps that are real

### 1. Nobody sells an instantly confirmed, slot-locked booking

This is the big one, and it holds up under scrutiny. Every single at-home player is a
**lead-generation and manual-allocation business wearing marketplace clothing**:

- **BookMyPooja** — "Priest details & prep list sent within **24 hrs**"; "Our seva team
  allocates Pandit within **24–48 hours** of booking"
- **Tathastu** — "Our puja coordinator **calls you within 15 minutes**"
- **99Pandit** — WhatsApp enquiry funnel; "Zero Upfront Cost, **Pay After Confirmation**"
- **Harivara** — WooCommerce cart, then offline allocation
- **SmartPuja** — closest to real: "Book with advance payment and get a confirmed booking"

**Not one of them lets you see a named purohit's specific open time slot and take it.**
You buy a *promise that someone will be assigned*. The deck's "no availability visibility"
claim is correct, and The Maithil's slot engine with `FOR UPDATE` locking is genuinely
ahead of the category.

**But read the other way:** five companies, some a decade old, have all independently
chosen *not* to build this. That is either a shared blind spot or evidence that manual
allocation converts better at low volume and gives ops the flexibility to reshuffle
purohits. Probably some of both. Worth learning before assuming it is purely a gap.

### 2. Nobody serves Kolkata with at-home Bengali purohits

This validates the launch city, and it is the most actionable finding here.

- **Harivara** lists exactly **one** Kolkata link: *"Odiya Purohits in Kolkata"*. No
  Bengali purohits in Kolkata at all.
- **BookMyPooja** sells "Bengali Pandit in Bangalore / Chennai / Mumbai / Delhi" — the
  Bengali **diaspora outside Bengal** — and has no Kolkata city page.
- **SmartPuja** and **99Pandit** have Kolkata pages, but both are Bangalore/Delhi-first
  and Kolkata is one of thirty-odd SEO landing pages.
- **Utsav is headquartered in Kolkata** (Chowringhee Road) — but sells temple-proxy puja
  and prasad, not a purohit at your door.

So: the biggest Bengal-native player in this space is not a competitor for at-home
bookings, and the at-home players treat Bengali as a diaspora language rather than a home
market. **Kolkata at-home purohit booking is genuinely unserved.**

*Corrected 8 Aug:* the earlier framing of this as "Bengali purohits" was wrong. Most
purohits working in Kolkata are Maithil Brahmins serving Bengali, Marwari, Bihari and
Maithil households across the city. The unserved market is not an ethnic segment — it is
**Kolkata households of every community, matched on vidhi, language and panjika**. That is
a larger market than the original read, and it removes a promise we could not keep. See
the addendum to ADR 0003.

### 3. Nobody does panjika school

Panchang itself is **table stakes, not a differentiator** — 99Pandit has daily panchang
plus chaughadiya; Utsav publishes panchang for 30 cities; YatraDham has a dosha
calculator. As *content*, this is commoditised, and the deck overstates it as a wedge.

What none of them does:

- bind panchang to **actual bookable purohit availability** (they show you an auspicious
  day, then a phone number)
- handle **Bisuddha Siddhanta vs Gupta Press** — the two Bengali panjikas that genuinely
  disagree

The second is unique to The Maithil and unique to Bengal. It is also the thing most likely
to make a Kolkata family trust the product on first use.

### 4. Nobody mentions cash — at all

Not one of the eleven sites mentions cash payment. But two tells suggest it happens
informally everywhere:

- **99Pandit**: "Zero Upfront Cost, **Pay After Confirmation**"
- **BookMyPooja** FAQ: *"Can I pay the balance amount to Pandit Ji directly?"* and *"Do I
  need to pay anything extra to the Pandit?"*

So cash is the unmanaged reality of the category, and the cash-ledger thesis is genuinely
unowned. **But** — the fact that every incumbent tolerates informal cash suggests they
have priced commission leakage as a cost of doing business rather than a problem worth
engineering around. The Maithil is betting they are wrong. That bet may be right; it is
not yet validated by anyone else's behaviour.

---

## The finding that most threatens the current design

**99Pandit advertises "Zero Upfront Cost, Pay After Confirmation" as a headline feature.**

The Maithil's entire architecture rests on the opposite: a mandatory online token at
confirmation, which is what makes cash safe and commission uncollectable-proof. It is a
good mechanism. But at the checkout screen, the competitor's offer reads as *"pay
nothing now"* and yours reads as *"pay ₹255 now"*.

That is a conversion disadvantage on first booking, against the player claiming the
largest supply. It does not invalidate the token model — it means the token needs to be
**sold**, not just implemented. Framing matters: "₹255 now locks your purohit and your
slot; the rest in cash on the day" is a very different sentence from "booking fee".

Worth A/B testing in the pilot, and worth knowing that if conversion suffers, the fix is
copy and trust signals, not abandoning the mechanism.

---

## What everyone has that The Maithil does not

These are all high-margin and require no field operations. Their universality suggests
they are what actually pays for the at-home business:

| Feature | Who has it |
|---|---|
| **E-puja / NRI** | All five. 99Pandit serves 10 countries; SmartPuja, BookMyPooja, Harivara all have it | 
| **Astrology** | SmartPuja, 99Pandit (kundali, matchmaking), Harivara (livastro.com) |
| **Samagri / prasad shop** | 99Pandit (shop.99pandit.com), Devaseva (shop.devaseva.com) |
| **Chadhava / group puja** | 99Pandit |
| **Content SEO engine** | Utsav is extraordinary here — chalisa, aarti, stotra, gyan, per-city panchang |
| **Mobile apps** | 99Pandit only, and notably a **separate partner app** for purohits |
| **Media & incubator badges** | The Hindu, ToI, Dainik Bhaskar; Startup India, NASSCOM 10K, T-Hub, NSRCEL |

The deck treats **NRI/e-puja as a phase-3 differentiator**. It is not — it is standard,
today, everywhere. That should be corrected.

---

## Positioning read

**The wedge that survives contact with the evidence:**

1. **Kolkata Bengali at-home** — genuinely unserved. Not "another city on a list of 30".
2. **Real slot booking** — nobody does it; you have it built.
3. **Dual panjika** — nobody does it; only matters in Bengal, which is where you are.
4. **Cash done properly** — unowned, but unproven as a customer need.

**Claims from the deck that the evidence does not support:**

- *"Muhurat intelligence — nobody schedules around muhurat today"* → panchang is
  everywhere. Only the **binding of panchang to bookable slots** is novel.
- *"Sampradaya matching"* as a wedge → every player segments by language and tradition,
  heavily, and has for years. It is table stakes.
- *"NRI & e-puja"* as a phase-3 differentiator → already universal.
- *"85,000 pujas / 2,100 pandits"* for SmartPuja → their site says 75,000 / 2,000.

---

## Three things I would do with this

**1. Narrow the pitch to Bengal, hard.** The defensible story is not "a better puja
marketplace" — five companies with a decade's head start own that phrase. It is *"the
platform that knows your family follows Gupta Press, and books a Bengali purohit into a
real slot on a date that is actually auspicious by your panjika."* Nobody else can say
that sentence.

**2. Add one zero-ops revenue line before scaling supply.** Every competitor has
astrology, a shop, or both, because at-home bookings alone are ops-heavy and thin.
Samagri kits are already modelled in the schema — that is the cheapest one to switch on.

**3. Resolve the domain question.** `themaithil.com` currently serves a React app titled
**"PoojaBooking"** — *"Connect with experienced pandits for your spiritual needs"*. If
that is yours, fine. If it is not, the brand name has a problem worth knowing about now
rather than after the logo is designed.

---

*Sources: each company's public website, fetched 7–8 August 2026. Volume, supply and
rating figures are self-reported marketing claims and are not independently verified.*
