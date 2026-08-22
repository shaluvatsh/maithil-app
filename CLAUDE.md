# Working notes for this repository

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

Where a change knowingly falls short, say so plainly in the response and record it in
`docs/ARCHITECTURE-REVIEW.md` rather than leaving it to be discovered.

## Verification

Run against a **fresh copy of the repo**, never a cached sandbox snapshot — a stale
copy has already hidden a build-breaking file from me.

```
pnpm typecheck && pnpm build && pnpm test
```

Tests catch structure, not appearance. Nothing about layout, spacing or whether a
control is reachable on a phone has been verified by a test; those need a rendered
page.

## Local dev

`tsx watch` orphans survive Ctrl-C and hold port 3000, so the API answering the
browser may not be the one whose logs you are reading. `main.ts` now detects this and
prints the fix. When anything behaves impossibly, check for an orphan first.


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
