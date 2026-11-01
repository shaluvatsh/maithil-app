# Scale and performance — community

`CONTRIBUTING.md` asks two questions of every change: *what happens at 10×, and what
happens on a second instance?* Community is the first surface where the honest answers
are uncomfortable, because these tables grow with **reads**, not with bookings, and
pan-India multiplies the read side by the number of cities while the write side stays
one household at a time.

## Feeds

### Keyset, never OFFSET

`OFFSET 2000` makes Postgres produce and discard 2000 rows. The cost grows with
engagement, so the query gets slower precisely as the feature works.

```sql
WHERE (published_at, id) < ($cursor_ts, $cursor_id)
ORDER BY published_at DESC, id DESC
LIMIT $n
```

```sql
CREATE INDEX posts_feed_idx ON posts (city_id, state, published_at DESC, id DESC)
  WHERE state = 'published';
```

The partial index matters: removed and held posts are dead weight in the hot index, and
a moderated feed accumulates them.

Encode the cursor in `packages/contracts` so the web app and the API agree on one
format. Page size bounds are Tier 2, clamped server-side.

### Counts are columns

A feed of 20 posts must fire **one** query. Not 20 author lookups, not 20 `COUNT(*)` for
replies, not 20 reaction counts.

- `pranamCount`, `replyCount`, `endorsementCount` are columns, maintained by trigger on
  insert/delete of the child row.
- Author display data joins once. If it cannot join, batch it with a single `IN` — never
  a lookup inside a `map`.
- Assert it: the harness runs real Postgres, so a test that counts statements around a
  feed call is cheap and is the only thing that stops N+1 returning.

### Partitioning, decided before it is needed

`CONTRIBUTING.md`: *"a table that only grows needs partitioning decided before it is
large."* For community the growing tables are `posts`, `post_reactions`,
`event_registrations` and `reports`.

Decision to record now, in ADR 0014: **range-partition `post_reactions` by month** —
it is the highest-volume, lowest-value table and it is append-mostly. Leave `posts`
unpartitioned; its growth is bounded by human writing speed. Revisit when
`post_reactions` passes ~50M rows.

## Geo — event discovery

A btree on `(lat, lng)` cannot serve a radius query. `CONTRIBUTING.md` already says so
and event discovery is precisely a radius query.

The pattern this codebase already trusts, from `search.service.ts`: **bounding-box
prefilter on the indexed columns, then haversine to order and to trim the corners.**

```
lat BETWEEN $lat - $dLat AND $lat + $dLat
AND lng BETWEEN $lng - $dLng AND $lng + $dLng   -- index-usable
-- then haversine in the ORDER BY / HAVING
```

`$dLat`/`$dLng` derive from the requested radius and the latitude — do not use one
degree-delta nationally, Guwahati and Chennai are 13 degrees apart and a fixed delta
over-scans one and under-scans the other. Radius max is Tier 3
(`COMMUNITY_EVENT_RADIUS_KM_MAX`); the per-city sensible default belongs in `Region`
(5 km in Mumbai is a neighbourhood, in Varanasi it is the city).

Honour `geo_precision` the way `addresses` does. A city-centroid event is not at a
location — every event in Kolkata shares that point, the distance between two of them is
exactly zero, and a "2.3 km away" label computed from it is a fiction. Show "in Kolkata",
not a distance.

Composite index for the real predicate, which is city + upcoming + published:

```sql
CREATE INDEX events_discovery_idx ON events (city_id, state, start_at)
  WHERE state = 'published';
CREATE INDEX events_geo_idx ON events (lat, lng) WHERE state = 'published';
```

If radius search becomes the dominant access path, the answer is PostGIS or
`earthdistance` with a GiST index — not a bigger bounding box. Decide by measuring.

## Search — the multi-script problem

Postgres full-text search is dictionary-driven and **there is no Bengali, Tamil,
Telugu, Kannada, Malayalam, Odia or Gujarati dictionary** in a stock install. A national
community index cannot use `to_tsvector('english', ...)` and pretend.

Options, in the order to try them:

1. `to_tsvector('simple', ...)` plus `pg_trgm` trigram indexes. No stemming, but exact
   and substring matching work across every script, and trigram similarity handles the
   transliteration variance (`puja` / `pooja` / `pūjā`) that a dictionary would not.
2. Store a normalised transliteration column alongside the native text, so a devotee
   typing Latin-script Bengali finds Bengali content. This is how people actually type —
   the assistant's system prompt already accounts for it.
3. A vector store only if 1 and 2 measurably fail. `assistant/knowledge.ts` argues the
   case against pgvector for the catalogue; that argument weakens for a large multilingual
   corpus, but it has to be earned with numbers, and `pgvector` is not installed.

Pick the language config from the row's `locale`, never from a constant.

## Fonts and scripts on a mixed feed

`packages/region/src/types.ts`: *"Drives which webfont subset is downloaded. A Chennai
user must never fetch Bengali."* On every existing surface `region.script` keeps that
promise, because the whole page is one region.

**A national feed breaks it.** One response can carry Bengali, Devanagari and Tamil.
Loading all nine subsets to be safe is a multi-megabyte regression on exactly the
low-end Android devices this product depends on.

The fix is per-item, not per-region:

- Derive the required script set from the rows actually in the response.
- Load subsets on demand, `font-display: swap`, one subset per script present.
- Default the feed to the viewer's region locales, so the common case loads one subset
  and mixed-script pages are the exception the user opted into by widening scope.
- Numerals follow the **viewer's** `region.numerals`, not the content's — a count is
  chrome, not content.

## Background jobs

*"A background job with no advisory lock corrupts itself the day you add a machine."*
Community adds three, and all three need `pg_advisory_lock`:

| Job | Hazard without a lock |
|---|---|
| Moderation triage | Two instances classify and hold the same post; duplicate reviewer work, duplicate notifications |
| Event reminders | Every registrant gets the reminder twice |
| Counter reconciliation | Two rollups double-count; counts drift permanently |

Anything with a side effect outside the transaction goes through the **outbox**, same as
booking (ADR 0005). A community notification published without it is lost on a crash
between COMMIT and PUBLISH, and the outbox relay's lease model already handles the slow
external call correctly.

Seat holds reuse the Redis KV slot-hold pattern. Note the existing gotcha: `REDIS_URL`
is real and persistent in local dev, so holds survive an API restart.

## Notifications — do not touch WhatsApp

`channels.ts` is explicit: every initiated message needs a BSP-approved template, 1–2
weeks per batch, and ADR 0008 already has six critical templates in the queue. Community
generates far more notification volume than bookings, and pan-India it generates it in
ten languages — each of which is a **separate template approval**.

**Rule: community notifications are in-app and push only. Never WhatsApp, never SMS.**
One exception: a T-24h reminder for a *paid* event registration, which is transactional
and deserves a template anyway. Digest, never per-event — one daily in-app roll-up
instead of fourteen pings.

## Caching and SSR

Public community pages are the acquisition channel — ADR 0008 cut `devotee-web`, and
community content is what quietly revives it inside the existing Next.js app, in
languages where nobody is publishing well.

- Server-render `/community/[space]/[slug]`, `/events/[city]/[slug]`, `/learn/[slug]`.
  *"A page Google cannot read has no acquisition channel."*
- `Cache-Control` on every public read. A published post is immutable until edited;
  `stale-while-revalidate` fits it exactly.
- JSON-LD: `FAQPage`, `Event`, `Article`. The `Event` markup is free distribution for
  every listed event.
- `hreflang` across the locales a piece of content exists in. This is the payoff for
  keeping translations in their own table.

## The measurement rule

*"Measure before claiming — count the statements, read the plan, check the bundle."*

For a community PR that means, in the description: statement count for the feed call,
`EXPLAIN (ANALYZE, BUFFERS)` for the feed and the geo query against ≥100k seeded rows,
and the bundle delta for any page that added a font subset. Seeding 100k synthetic posts
into the wasm Postgres harness is a fixture, not an integration test — write it once and
reuse it.
