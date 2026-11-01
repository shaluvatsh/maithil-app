# ADR 0016 — Moderation posture and intermediary obligations

Status: accepted, 19 September 2026.
Builds on ADR 0014 (community bounded context).

---

## Context

The moment a third party can publish, this product is an intermediary under the
Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules,
2021. That brings obligations with clocks attached: a named Grievance Officer, an
acknowledgement within 24 hours, a resolution within 15 days, and removal within 36
hours of a valid court or government order.

It also brings a harder problem than compliance. This is a Hindu religious forum,
operating pan-India, in eleven languages across nine scripts, run by one or two
engineers. The content that will actually arrive includes sectarian attack, caste
slurs, communal provocation during festival season, political mobilisation, astrology
offered as medical advice, solicitation for tantric and vashikaran "services", miracle
cures, and — most frequently of all — a purohit and a devotee agreeing to transact
off-platform.

Nobody on the team reads most of those languages. Buying moderation capacity in eleven
languages is not affordable before product-market fit, and a classifier good enough to
act unsupervised on religious argument in Maithili does not exist to be bought either.

The conclusion that shapes everything below: **moderation capacity is the binding
constraint on this surface, so the design must minimise the amount of moderation
required rather than maximise the amount performed.**

## Decision

### 1. Nothing is ever deleted automatically. It is held.

`community_post_state` is `published | held | removed`. Triage sets `held`; only a human
sets `removed`. The asymmetry is deliberate and it is the whole posture: a false
positive that silently deletes a grieving devotee's question about their father's
shraddha is worse than a slow queue, and it is invisible — they simply never come back.

### 2. Structure does more than review.

Four decisions that remove content categories before any moderator sees them:

- **Spaces are scoped to a ritual or a city.** A thread lives under "Annaprashan" or
  "Kolkata". "Is Hinduism under threat" has nowhere to sit. `general` exists as an enum
  value but is not opened at launch.
- **`posting_policy` is structural.** A space only verified purohits may write in needs
  no queue at all.
- **The trust ladder.** React and reply are open immediately; asking needs an account
  that has existed for `COMMUNITY_TRUST_ASK_AFTER_HOURS`; starting a discussion needs a
  completed booking or an operator. This removes the cheapest throwaway-account spam at
  zero ongoing cost. `restricted` is never auto-promoted out of — a moderator's decision
  is not undone by the passage of time.
- **No direct messages.** Not at launch, and not without a specific reason later. DMs are
  where fraud, grooming and disintermediation live, and they are invisible to everyone
  who might intervene.

### 3. One reaction, and it is a pranam.

No downvote. Downvotes in a religious forum become sectarian scorekeeping within a week
and there is no version of that worth operating. Modelled as an enum of one rather than
a boolean, so the absence is recorded as a decision.

### 4. Verified answers outrank everything, by role.

Peer endorsement orders answers *within* the verified tier; pranams order within that.
Popularity never lifts an unverified answer above a verified one. A board where a loud
layperson can outrank a shastri destroys the authority the surface exists to build, and
no ranking weight repairs that afterwards.

Only a verified purohit may endorse, only an answer, and never their own — enforced by
`assert_endorser_verified` in SQL, because in application code one missing import
bypasses it.

### 5. The prohibited-term lexicon is a table, not a constant.

`community_moderation_terms`, keyed by locale, matched against a normalised body. Eleven
languages in nine scripts plus the Latin transliteration everyone actually types; the
list will be wrong on launch day and will need a row added during an incident. In a
TypeScript array that is a deploy, at night, under pressure. Empty is a valid state and
means everything publishes.

Triage runs through the existing assistant (`assistant.service.ts`), whose system prompt
already handles Bengali, Hindi and English in Latin script — which is precisely the
pan-India moderation problem. It classifies; it does not decide.

### 6. Contact details are stripped on write, and kept.

`scrubContact` removes phone numbers, emails, UPI VPAs, links and handles from the
rendered body and replaces them with a sentinel the client localises. The raw text is
written to `community_post_revisions`, which is append-only, so a reviewer can always
see what was typed.

This is a safety control before it is a commercial one. A devotee who moves off-platform
loses the escrow, the OTP handshake at start and completion, the refund tiers and the
dispute path — the protections are the product, and they do not travel.

### 7. Compliance clocks are columns; the windows are configuration.

`community_reports` carries `created_at`, `acknowledged_at`, `resolved_at`.
`COMMUNITY_GRIEVANCE_ACK_HOURS` (24) and `COMMUNITY_GRIEVANCE_RESOLVE_DAYS` (15) are
environment configuration with defaults, because they are legal windows set outside this
codebase and a shorter internal target must be settable without a release.

One report per person per post, enforced by a unique index. A pile-on is not stronger
evidence, and letting it be one turns the queue into a popularity contest.

Moderation actions reuse `audit_log`. There is one append-only audit spine and it is not
worth having two.

### 8. Refusals say "not yet", not "not allowed".

`COMMUNITY_TRUST_REQUIRED` maps to 409, not 403, following the precedent set by
`PAYOUT_ACCOUNT_MISSING`. The request is permitted and well formed; the account is
simply not old enough yet, and the fix is time or a completed booking rather than a
permission the person lacks. A 403 sends a first-time devotee to a "you are not allowed"
screen for something they will be allowed to do tomorrow.

## Consequences

**Someone must be named as Grievance Officer before C1 is public**, with a published
contact route and a page carrying it. This is a founder task with a lead time, like the
items in ADR 0008's P0-0, and it is not an engineering deliverable.

**The queue needs an owner and a daily habit.** Held posts and open reports both sort
oldest-first, and both have partial indexes serving exactly that. If queue age climbs,
the container is wrong — the answer is a structural change (narrow a space, tighten a
policy), not more reviewing.

**Community guidelines have to be written, in the languages people post in.** A
prohibited list nobody can read is not notice.

**The trust ladder will annoy real purohits** who join, want to answer, and find they
can. They can — answering and replying are open at `newcomer`. Only starting a thread
waits. That is the right trade, but the copy has to carry it.

**Contact scrubbing will have false positives**, and it is deliberately blunt: it will
not catch "nine eight three zero zero", a number in an image, or a handle spelled
sideways. Chasing those is an arms race a two-person team loses. The `redacted` flag
feeds a metric, and the metric is what says whether the arms race has begun.

**This is reviewable, not solved.** Everything above is sized for launch traffic with no
dedicated moderator. The first festival will test it.

## Alternatives considered

**Auto-remove on a lexicon match.** Rejected — see decision 1. The failure is silent and
it lands on exactly the people least able to complain about it.

**An open general forum from day one, moderated reactively.** Rejected. It maximises the
moderation required at the moment there is least capacity to do it, and the content
categories hardest to judge are the ones a general forum invites first.

**Buy a third-party moderation API.** Rejected for now. Coverage of Indic languages is
weak, coverage of religious nuance in them is weaker, and the judgement that matters
here — whether two purohits are disagreeing about a vidhi or attacking each other's
tradition — is exactly what a general-purpose classifier cannot make. Revisit when
volume justifies a human moderation team, at which point the tool supports them rather
than replacing them.

**Public karma and follower counts.** Rejected at launch. Status games manufacture the
drama that then has to be policed, and the scoreboard is the incentive.
