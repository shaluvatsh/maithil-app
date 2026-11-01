# Contributing to The Maithil

Read this before your first change. Everything here was learned the expensive way —
each rule exists because its absence already cost a debugging session or shipped a
bug.

## Standing constraint

**Every change must be scalable, modular and optimised — in all aspects, design and
code.** This is not a review checklist applied at the end; it is a condition on the
work as it is written.

Concretely, before anything is considered done:

**Modular.** Does it belong where it is? Shared meaning goes in `packages/region`
(what a city *is*) or `packages/contracts` (state machine, pricing, refunds) so the
API, the web app and future mobile clients read one source of truth. Depend on the
capability, not the class — `BookingService` takes a `matchPandit` function, not
`SearchService`. Anything that varies by city, ritual or tradition is **data**, never
a branch.

**Scalable.** What happens at 10× and at a second instance? Two questions that have
already caught real faults here: a background job with no advisory lock corrupts
itself the day you add a machine, and a table that only grows needs partitioning
decided before it is large. Anything placed on the booking hot path must be cheap
enough to run per booking, and indexed for the predicate it actually uses — a btree
on `(lat, lng)` cannot serve a radius query.

**Optimised.** No query inside a loop; one multi-row statement instead. Cacheable
reads carry `Cache-Control`. Pages that can be server-rendered are, because a page
Google cannot read has no acquisition channel. Measure before claiming — count the
statements, read the plan, check the bundle.

Where a change knowingly falls short, say so plainly in the pull request and record
it in `docs/ARCHITECTURE.md` under "Known gaps" rather than leaving it to be
discovered.

## Multi-city rules

The product launches in Kolkata but the code is pan-India from day one. Two
consequences that are easy to get wrong:

- **Slot counts differ per city.** Kolkata and the northern cities use four slots;
  the southern cities (`SOUTH_SLOTS` in `packages/region`) use five. Never hardcode
  `4`, `max(3)`, or a fixed label array — derive from `region.slots`.
- **Never format a city's data with another city's rules.** Money, dates and slot
  labels come from `useRegion()` on the web side and `getRegion(citySlug)` on the
  API side. A hardcoded `en-IN`/`₹`/`'6-9 am'` is a bug waiting for the second city.

## Verification

Run against a **fresh copy of the repo**, never a cached sandbox snapshot — a stale
copy has already hidden a build-breaking file.

```
pnpm typecheck && pnpm build && pnpm test
```

Check the exit code directly. Piping through `tail`/`head` masks failure, because the
pipe reports the exit status of the last command, not the test run:

```
pnpm test > /tmp/test.log 2>&1; echo "EXIT=$?"
```

**`pnpm test` serialises the packages, and has to.** `turbo run test` ran all four at
once by default: the API suite holds two Postgres-in-wasm forks and the web suite
spins up a vitest thread per core, so together they exhausted memory. Vitest then
reported "Worker exited unexpectedly", marked a whole file's cases as *pending* rather
than failed, and produced failures that vanished when a suite was re-run on its own —
the worst possible signal, because it teaches you to re-run rather than to read.

`--concurrency=1` in the root script fixes it. It is slower and it is not optional:
`apps/api/vitest.config.ts` already caps its own forks for the same reason, and that
cap is worthless if another package is running beside it. If you split this into CI
jobs, give the API suite a job of its own rather than raising the concurrency back.

Tests catch structure, not appearance. Nothing about layout, spacing or whether a
control is reachable on a phone has been verified by a test; those need a rendered
page — see `scripts/e2e/`.

## Local dev

Both apps start together from the repo root:

```
pnpm dev          # API on :3000, web on :3001
```

Stopping needs three steps, not one, or it leaves orphans:

```
lsof -ti :3000 -sTCP:LISTEN | xargs -r kill -9
lsof -ti :3001 -sTCP:LISTEN | xargs -r kill -9
pkill -9 -f "turbo run dev"
```

The third line is not optional. The PID captured from `pnpm dev &` is the shell
wrapper, not turbo, so killing it leaves the real process tree running.

`tsx watch` orphans survive Ctrl-C and hold port 3000, so the API answering the
browser may not be the one whose logs you are reading. `main.ts` detects this and
prints the fix. **When anything behaves impossibly, check for an orphan first.**

If pages render unstyled or a chunk 404s (`Cannot find module './352.js'`), the Next
build cache has drifted: `rm -rf apps/web/.next` and restart.

**Running `pnpm build` while `pnpm dev` is up used to kill the API.**

`build` rewrites `packages/*/dist`, and the API's `tsx watch` restarted on that —
mid-write, sometimes failing to come back. What you were left with is the worst
possible shape: the web server still answering on :3001, the API gone from :3000, and
an app that looks exactly as though the database had died. It had not; nothing in
Postgres was involved.

`apps/api`'s `dev` script now passes `--exclude '../../packages/*/dist/**'`, so the
API no longer restarts when a workspace package is rebuilt. `predev` still builds both
packages before the server starts, so a normal session is unaffected. The one thing
you lose is hot-reload on a change inside `packages/region` or `packages/contracts` —
**restart the API by hand after editing either.** That is a better trade than a
watcher that takes the server down when the verification gate runs.

This is the API-side half of the same problem `.next-build` solved for the web app,
and it had the same cause: two things writing to a directory a running process was
watching.

**This used to happen every time you ran the verification gate.** `next build` and
`next dev` both defaulted to `apps/web/.next`, so a production build replaced the dev
server's chunks underneath it and every later request 500s until the cache was
cleared. The advice was "stop the dev server first", which is advice nobody remembers
at the moment it matters.

The build now writes to `.next-build` instead — `distDir` in `next.config.mjs` keys
off `NODE_ENV`, which Next sets to `production` for both `build` and `start` and to
`development` for `dev`. The two no longer share a directory, so the gate can run
against a live dev server. If you still see a missing chunk, it is a genuinely stale
dev cache and the `rm -rf` above is the fix.

## Workspace packages are consumed as source, never as `dist`

`@themaithil/region` and `@themaithil/contracts` publish `dist/**` through their
`exports` map. Anything that resolves them by package name gets whatever was last
compiled, and a stale `dist` produces a runtime error that neither typecheck nor the
test suite can see — typecheck reads `src`, and turbo rebuilds before `test`.

This has cost two debugging sessions:

- `categoryFor` missing from `dist` → `db:seed` died with "does not provide an export
  named 'categoryFor'".
- `computableSchool` missing from `dist` → the home page died with
  "computableSchool is not a function".

So: `apps/web` aliases both packages to `src` in `next.config.mjs` and
`vitest.config.mts`, and `apps/api` rebuilds them in a `predev` / `predb:*` hook
because `tsx` resolves by package name. **If you add a new consumer of a workspace
package, wire it to source or give it a pre-hook.** Adding another test that checks
for staleness is not the fix — the fix is that there is only one copy of the code.

## Redis is real in local dev

`REDIS_URL` points at a real, persistent instance. Rate-limit counters, OTP codes and
slot holds survive an API restart, so a burst of local testing can lock you out of
your own login (the OTP request limit is **per IP**, not per phone). `redis-cli
FLUSHDB` is the safe reset — Redis holds nothing durable here.
