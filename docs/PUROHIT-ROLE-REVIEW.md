# The purohit side: review and what to build next

A marketplace fails on the supply side first. A devotee who has a bad experience
books elsewhere; a purohit who has a bad experience stops answering, and the demand
side then has nothing to buy. This is a review of everything the pandit role touches
— four web files, one API module, and the parts of booking, payouts, search and
notifications that a purohit lives inside — followed by what has to be built.

Everything in "What is missing" was verified against the code, not inferred from the
design docs. Where a gap is claimed, the check that found it is named.

---

## 1. What exists, and is good

The bones are better than the gaps suggest.

**The availability model is right.** Storing per `(date, slot)` is correct for
booking — a lock has to land on a specific afternoon — and the weekly pattern
(`panditWeeklyPatterns`, `PUT /v1/me/purohit/weekly-pattern`) sits on top as the
declaring shape. "I work Tuesday and Thursday mornings" is one sentence; saying it
through the per-date calendar was 120 taps. Exceptions correctly beat the pattern,
and a booked slot survives a pattern change — which is the one thing that must never
break, because regenerating a calendar from a changed pattern would release a
confirmed puja out from under a devotee.

**Auto-accept (ADR 0011) is coherently implemented.** A published slot *is* the
acceptance, so there is no accept button, and the screen now says which way the
waiting runs. That was a real fix: a purohit looking for a missing accept button
concludes the app is broken.

**The earnings breakdown is honest.** Cash jobs mean the purohit holds the devotee's
money and owes the platform its commission, so gross and payable differ by an amount
they never received. Showing only the net turns a legible deduction into an
unexplained shortfall. `EarningsPanel` itemises it, including TDS carried under
s.194-O.

**Onboarding is shaped for the actual persona.** Four steps, one decision per screen,
saved on advance, large targets — right for someone 30–65 on a low-end Android,
often outdoors and one-handed.

**Search does not bill per keystroke.** Haversine in SQL rather than the Distance
Matrix API; the Maps call happens once, at confirmation. Re-ranking 50 results on
every filter change through a paid API would have been a cost bomb.

---

## 2. What I fixed in this pass

### Purohits in 8 of 14 cities could not name the language they work in

The onboarding wizard offered six hardcoded English strings: Bengali, Hindi, English,
Maithili, Odia, Marwari. That is Bengal's list. A Chennai purohit could not record
**Tamil**; Bengaluru could not record Kannada, Mumbai and Pune Marathi, Ahmedabad
Gujarati, Hyderabad Telugu, Bhubaneswar Odia-as-a-code. Marwari, which no city
declares, was offered to everyone.

This is not cosmetic. Search filters with an array overlap:

```sql
AND pp.languages && ARRAY[...]::text[]
```

A language you cannot record is a filter you can never match. It is the same total
exclusion the wrong-city bug caused, and it fails the same silent way — no error, no
empty state, the purohit simply never appears.

Worse, **the column has held two incompatible encodings the whole time.**
`db:seed:dev` writes locale codes (`{bn,hi}`); the wizard wrote display names
(`{Bengali}`). A devotee filtering for `bn` matched every seeded purohit and no
self-registered one. The two halves of the supply were never comparable, and nothing
ever failed loudly enough to notice.

Fixed: `packages/region/src/languages.ts` derives the offer from the region's own
`locales`, ordered city-first; the API now refuses anything that is not a known
locale code; `0012_language_codes.sql` repairs existing rows; admin and verification
screens translate codes back to names so an operator never reads "bn, hi". 27 tests
pin it, including one per live city.

### Two disagreeing money figures on the purohit dashboard

`/purohit` summed `dakshina + samagri + travel` across whatever jobs were in the
list and labelled it "Completed earnings", directly above `EarningsPanel` reporting
the ledger. The card knew nothing about commission on cash jobs, TDS carry, or prior
payouts — so it was reliably the larger number, and it was the first one a purohit
saw. Two answers to "what have I earned", the bigger one wrong, is what a payout
dispute is made of. The ledger is the only thing that can answer it, so it now does;
the card shows a count, which the job list genuinely knows.

### Releasing a job ran through `window.prompt`

The most consequential control on the screen — it cancels a devotee's puja and
triggers a re-match — collected its reason in a browser dialog that is unstyled,
untranslatable, suppressible after a previous dismissal, and blocked outright in a
cross-origin iframe. A purohit whose browser suppresses it clicks and nothing
happens. Moved onto the project's existing focus-managing `Modal`.

### A `sql.raw` splice of user input in the widest query in the system

The language filter interpolated query-string values into SQL behind a hand-rolled
`.replace(/'/g, '')`. Probably safe; resting entirely on one regex that any future
edit could weaken, in the query that reads the whole supply table. Now a bound
parameter, with values narrowed to known locales first.

### Wasted work and dead code

- `GET /v1/auth/me` was fetched on every `/purohit` load *and* after every accept,
  release and completion, and assigned to a variable nothing read.
- `myCityId()` extracted: four endpoints opened with the same six-line
  select-and-throw, and `openCalendar` followed it with
  `SELECT cities.id WHERE cities.id = $1`, which can only return what it was given.
- Deleted: `components/ui.tsx` (whole file — its own comment warned that a primitive
  nobody uses is a second definition of the same styling waiting to disagree; the
  remaining two had since gone unused too), `PanchangStrip` plus its stylesheet rules
  **plus the test that measured it** — the component had been removed from the page
  while its export, CSS and assertion all survived, so the test was passing on a rule
  with nothing to style and reading as coverage. Also `bn()` and `SLOT_LABELS`, an
  abandoned Bengali-numeral localisation with zero call sites, and two empty
  `_tmp_*` files at the repo root.

---

## 3. What is missing — ordered by what breaks first

### P0 — the lifecycle does not close

**1. A purohit cannot be paid.**
`panditProfiles.linkedAccountId` is referenced only by `razorpay.client.ts`.
**Nothing ever sets it.** There is no bank-account or UPI capture anywhere in
onboarding or the profile. `PayoutService` computes a correct net payable that has
nowhere to go, while `EarningsPanel` tells the purohit "payouts run weekly". That is
a promise the system cannot keep. This is the single most urgent item: everything
else is a worse version of a working product, and this one means the product does not
work at all.

*Build:* account capture in onboarding (a fifth step) and in the profile; penny-drop
or Razorpay Route validation; the linked-account id written on success; payout
blocked with a clear reason until it exists.

**2. Nothing ever creates a KYC record.**
`grep 'insert(kycRecords)'` returns nothing. The admin verification queue counts
documents per purohit and will always render `0`. There is no document upload
anywhere. `kycStatus` can never reach `submitted`, so the queue's
`IN ('pending','submitted')` filter has a permanently unreachable arm, and an admin
approves a purohit on the strength of a name and a years-of-experience number.

For a service that sends a stranger into a family's home for a religious ceremony,
"verified purohit" is the core claim on the home page. Right now it means an
operator clicked a button.

*Build:* document upload (Aadhaar/PAN last-4 + image to R2 per ADR 0010),
`kyc_records` rows on submit, status transition to `submitted`, admin review against
the actual document, and the 30-day purge the schema already provides for.

**3. Verification decisions are never communicated.**
`verification.controller.ts` contains no notification call. The onboarding wizard's
final screen says, in as many words: *"You will get a message when that is done."*
Nothing sends it. A purohit finishes setup and waits for a message that does not
exist — and cannot tell "still in review" from "rejected".

*Build:* `pandit.kyc.verified` and `pandit.kyc.rejected` templates with the reason;
a visible status on `/purohit` while pending.

**4. A purohit is not told when a devotee cancels.**
Templates that exist: `booking.confirmed.pandit`, `booking.confirmed.devotee`,
`booking.cancelled.devotee`, `booking.pandit_changed.devotee`, `payout.completed`,
two OTP templates. There is **no `booking.cancelled.pandit`.** A purohit who blocked
an afternoon, turned down other work, and may already be travelling finds out by
refreshing the dashboard.

*Build:* the missing template, plus `booking.reminder.pandit` and
`booking.reminder.devotee` the day before — the highest-ROI notification in any
scheduled-services marketplace, because it is what prevents no-shows.

### P1 — supply acquisition and retention

**5. There is no page that recruits a purohit.**
The header offers a signed-out visitor "For Pandits" → `/purohit` → immediate
`router.replace('/login?next=/purohit')`. A prospective purohit is shown a login wall
and never told what they would earn, how the commission works, that cash jobs are
supported, or that an open slot is a commitment. `nav-model.ts` correctly says supply
signs up from the public site; the public site has nothing for them.

*Build:* a real `/for-pandits` landing page — earnings maths with actual city price
bands, the auto-accept contract stated plainly, what verification requires, how long
it takes — and route `/purohit` by role.

**6. A purohit cannot see their own reviews or rating.**
`GET /v1/pandits/:id/reviews` exists. Nothing in the web app calls it.
`ratingSum`/`ratingCount` surface only in the admin console. The person whose
livelihood depends on the rating is the one person who cannot see it, and cannot see
what a family said or respond to it.

**7. `POST /v1/me/payouts/instant` is implemented, tested, carries a ₹10 fee — and
has no button.** Revenue and a retention lever, both unreachable. (Blocked on item 1.)

**8. `acceptanceRate` is never written or read.** Either compute it and use it in
ranking — a purohit who reliably releases jobs should rank below one who does not —
or drop the column. A field that looks live and is not will eventually be trusted by
something.

### P2 — promises the UI already makes

**9. Disputes.** `disputes` is a defined table with **zero code touching it**, and
the purohit dashboard already tells a purohit that a cash mismatch "raises a dispute
rather than settling". Nothing raises anything. The completion is simply refused,
with no path forward and money in the middle.

**10. Promo codes.** `promoCodes` and `promoRedemptions` — also zero code. No UI
promises these, so this is a decision, not a bug: build them or drop the tables. I
have deliberately not dropped any of these three, because dropping tables is
destructive, they are clearly planned rather than abandoned, and item 9 is referenced
in shipped copy.

**11. Purohit-side cancellation consequences.** Releasing a job is free and
unlimited. There is no strike count, no effect on ranking, no cooling-off. Under
auto-accept, a purohit who over-publishes and releases half of it is strictly better
off than one who publishes honestly — the incentive currently points the wrong way.

---

## 4. Suggested sequence

| Order | Item | Why here | Status |
|---|---|---|---|
| 1 | Bank account capture (#1) | Nothing else matters if they cannot be paid | **Done** |
| 2 | KYC upload + submitted state (#2) | Unblocks verification and the core trust claim | **Done** |
| 3 | Cancel + reminder + KYC notifications (#3, #4) | Cheap, and each one is a promise already made | |
| 4 | `/for-pandits` landing page (#5) | Acquisition has no front door | |
| 5 | Reviews visible to the purohit (#6) | Retention; endpoint already exists | |
| 6 | Instant payout button (#7) | Revenue; small once #1 lands | |
| 7 | Acceptance rate: compute or drop (#8) | Fixes the auto-accept incentive with #11 | |
| 8 | Disputes (#9) | Shipped copy promises it | |

Items 1–3 are the ones I would not launch without.

---

## 5. Verification

Typecheck, build, and the full suite on a clean copy: **808 tests across 4 packages,
all passing** (contracts 26, region 207, web 310, api 265).

Two things worth flagging about the process:

The project's own dead-class guard caught a stale rule (`.native`) that my own
dead-code scan missed, because "native" appears as an ordinary word elsewhere in the
source. The stricter check was the existing one.

While deleting `PanchangStrip` I removed the function signature and left its body
orphaned — the same failure mode that broke the stylesheet twice earlier in this
project, now in TSX. Typecheck caught it. Deleting code by pattern-matching a
signature is not safe; the removal has to be brace-balanced, and the stylesheet edit
in this pass was done selector-aware for that reason, with a brace-balance assertion
afterwards.
