# Community data model — conventions

New bounded context: `apps/api/src/db/schema/community.ts`. One file, the house pattern
of one file per context. **No foreign key points from booking into community.** Community
may reference `users`, `cities` and `rituals`; nothing in booking, ledger or payments may
reference community. The test is: could you `DROP` the community tables and still take a
booking? If not, the coupling is wrong.

## Shared column conventions

Copy the local helpers already used in every schema file — `id()`, `ts()`, `created()`,
`updated()`. ULIDs for ids, `text` primary keys, timestamps `withTimezone` in `string`
mode. Consistency here is not cosmetic; the test harness and the audit spine assume it.

Every community table carries the Law 1 scope triple:

```ts
scope:     communityScopeEnum('scope').notNull(),   // city | state | national
cityId:    text('city_id').references(() => cities.id),
stateCode: text('state_code'),
locale:    localeEnum('locale').notNull(),
```

with the pairing enforced in SQL, in the same migration that creates the table (see
`SKILL.md` step 3 for why not `9999_guards.sql`):

```sql
ALTER TABLE posts ADD CONSTRAINT posts_scope_target CHECK (
  (scope = 'city'     AND city_id IS NOT NULL) OR
  (scope = 'state'    AND state_code IS NOT NULL) OR
  (scope = 'national' AND city_id IS NULL AND state_code IS NULL)
);
```

## Snapshot what the reader's world depends on

`bookings.panjikaSchool` is snapshotted so a later preference change never rewrites
history (ADR 0003). Community needs the same discipline for a different reason: an
answer about a tithi is **only true under one almanac**, and a question asked in Patna
under purnimant months is a different question in Kolkata under amanta.

So: snapshot `panjikaSchool` on any post or event whose correctness depends on a
calendar, and render it as a visible qualifier, not as metadata. A verified answer that
says "গুপ্ত প্রেস অনুযায়ী" is trustworthy pan-India. The same answer unlabelled is
wrong in half the country.

## The panjika enum is now the blocker

`packages/region/src/types.ts` already states it: `panjika_school` is a Postgres enum,
`ALTER TYPE` can add but never remove or reorder, and it should become a reference table
**before city three**. Community is what forces this — events, posts and knowledge items
all want a panjika foreign key, and a national rollout adds almanacs faster than cities.

**Do the enum → reference table migration before C2, not after.** It is cheap now and
expensive once three regions hold production community rows pointing at it.

## The three entity groups

### Posts (C1)

Questions, answers, replies. One level of nesting — question → answer → reply, and stop.
Enforce it as a guard, not a service check — `0026_community.sql` ships
`assert_post_shape`, which also pins the kind hierarchy so a reply can never hang off
a question and skip the answer it was replying to:

```sql
-- A reply's parent must itself have no parent. No deep threads.
CREATE OR REPLACE FUNCTION assert_post_depth() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM posts p WHERE p.id = NEW.parent_id AND p.parent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'posts nest one level only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Also guard: **only a verified purohit may write `post_endorsements`** (`kyc_status =
'verified'`). That is the quality signal the whole surface rests on; it does not belong
in application code where one missing import bypasses it.

Keep `post_revisions` append-only in the spirit of `booking_events` and
`ledger_entries` — an edited answer that changed a ritual instruction must be
reconstructible.

### Events (C2)

**Events are not bookings.** A booking is one devotee, one purohit, one address, escrow,
OTP start/complete, travel buffers, refund tiers, TDS. An event is many devotees, one
host, a public venue, no travel, no samagri. Forcing events through `bookingStateEnum`
puts `cancelled_pandit` and `offlineCaptureAt` on a temple kirtan and poisons a state
machine that is currently correct. Write ADR 0015 saying so.

Reuse instead: the ledger (all money, always), `payment_intents`, the outbox,
`pincode_centroids`, the Redis hold pattern, the OTP-hash pattern for check-in, and the
panchang engine.

Capacity lives on `event_sessions`, not `events` — a nine-day paath and three daily
aartis are sessions. **Capacity integrity is community's ledger invariant:**

```sql
ALTER TABLE event_sessions ADD CONSTRAINT seats_within_capacity
  CHECK (capacity IS NULL OR seats_taken <= capacity);
```

Take `SELECT ... FOR UPDATE` on the session row inside the registration transaction.
The CHECK is the seatbelt: a path that forgets the lock fails loudly instead of quietly
seating 210 people in a hall of 200. Counting registration rows and comparing is a race
and it *will* oversell.

Two tiers, expressed as `registrationMode`, not as policy documents:

| | Listed | Hosted |
|---|---|---|
| Who | anyone | verified purohit / verified org |
| Money | none | ticketed or seva slots |
| Liability | intermediary | yours |
| Review | post-hoc, flag-driven | pre-publish, always |

**A devotee-listed event can never take money through the platform.** One enum value
kills the fake-ticketed-puja fraud class.

Absolute instants for `startAt`/`endAt` — ADR 0006's lesson, and doubly so nationally:
a local date plus a slot index is meaningless across a feed that spans cities.

New `ledgerEntryTypeEnum` values: `event_ticket`, `event_refund`, `event_commission`.
Settlement on event completion, not on purchase.

> **Ask the CA alongside the s.194-O and s.9(5) questions already in ADR 0008's P0-0:**
> entry to a religious ceremony is GST-exempt under Notification 12/2017 entry 13 below
> a per-person threshold. If ticket prices sit under it, ticketed events may be exempt
> where marketplace commission is not. Pan-India that is a large number of transactions
> to get wrong.

### Knowledge (C3)

Separate from `posts`. Forum content is conversational, single-locale, unreviewed.
Knowledge items are curated, translated, versioned, cited and SEO-indexed — structurally
closer to `rituals` + `ritual_translations`. Merging them grows an editorial workflow
onto the posts table.

- i18n in `knowledge_translations`, per ADR 0009. Primary locale mandatory to publish —
  and **primary means `region.locales[0]` for the target region, not `'bn'`.**
- `knowledge_citations` (work, chapter, verse). Every claim points at a source; this is
  the trust moat against a category full of unsourced text.
- Guard: `status = 'published'` requires `reviewed_by NOT NULL`, and the reviewer must
  be a verified purohit or ops. Quality bar, safety valve and differentiator in one
  constraint.
- Media keys go through `storage/object-store.ts`. Audio matters more than text here —
  `chantingSampleUrl` exists because that was already understood.

Feed the published corpus into `assistant/knowledge.ts`. Its own comment names this
future: *"If the corpus later grows past what fits comfortably — a blog, thousands of
ritual variants across many regions — this is the one function to change."* `retrieve()`
is the seam. Pan-India is exactly when the corpus outgrows a compact render, so expect
to change that function and nothing above it.

## Identity — the rule with no exceptions

**Community identity is not marketplace identity.**

Devotees book for shraddha of a dead parent, for fertility rituals, for illness. A
`community_profiles` row holds a chosen display name and avatar. No phone, no booking
history, no "booked 4 pujas" badge. Purohits appear under their verified identity with
the ✓, experience and panjika — that asymmetry is the product.

Never render `users.name` on a community surface. Put the mapping behind one function
and write the test that fails if anything else reaches it.

## Moderation and compliance tables

You are an intermediary the moment a third party posts, so IT Rules 2021 apply: a named
Grievance Officer, 24h acknowledgement, 15-day resolution, 36h takedown on a valid
order. Ship the grievance page with C1, not after the first notice.

- `reports` — entity, reporter, reason enum, state, **SLA clock**.
- `moderation_terms` — per locale and per script, in the database (Tier 4). Pan-India
  this is ten-plus languages and both native and Latin script; a TypeScript array means
  a deploy during an incident.
- Moderation actions reuse `audit_log`. You already have one append-only audit spine —
  do not build a second.

Triage through the existing assistant (`assistant.service.ts` has a Claude loop and a
scripted-fake seam for tests). Its system prompt already handles Bengali, Hindi and
English in Latin script, which is exactly the pan-India moderation problem. **Hold for
review, never auto-delete** — a false positive that silently deletes a grieving
devotee's question is worse than a slow queue.

Structural choices that cut moderation load more than any classifier: no DMs; a trust
ladder (react → reply after 24h → ask → post after a completed booking); spaces scoped
to a ritual or city so "is Hinduism under threat" has no home; no public follower counts
or karma leaderboards at launch.

## Anti-disintermediation

A forum introduces devotees to purohits for free. That is the feature and the leak.

1. Scrub phone/UPI/email from post bodies on write; keep the raw in `post_revisions`.
2. "Book this purohit" on every answer and profile.
3. Tag bookings with a community source, or you cannot justify the moderation cost at
   month six.
4. Reward contribution with a **capped** ranking boost — the `newSupplyBoostRemaining`
   pattern.

> Community reputation must never enter `bayes_rating`. The ranking in
> `search.service.ts` is carefully built on service quality with a Bayesian prior. If
> forum karma can outrank a 4.8-star purohit, you have made the marketplace worse to
> make the forum busier. A tiebreak term, worth less than acceptance rate.
