---
name: run-themaithil
description: Build, run, and drive the themaithil app (NestJS API on :3000, Next.js web on :3001) against a real local Postgres/Redis. Use when asked to start the app, take a screenshot of it, test a booking/purohit/admin flow, or confirm a change works end to end (not just unit tests).
---

themaithil is two servers sharing one Postgres + one Redis: `apps/api` (NestJS,
`:3000`) and `apps/web` (Next.js, `:3001`). "Running the app" means both are up,
seeded, and driven with a real browser - `chromium-cli` is not installed on this
box, so this skill ships its own Playwright REPL driver instead. All paths below
are relative to the repo root.

## Prerequisites (once)

- Postgres running locally with a `themaithil` database. `.env` in the repo root
  should already have `DATABASE_URL` pointed at it (Homebrew Postgres has no
  password by default: `postgres://$(whoami)@localhost:5432/themaithil`).
- Redis running locally (`redis-server`), matching `.env`'s `REDIS_URL`. **This is
  a real persistent instance, not an in-memory fallback** - rate-limit counters
  and OTP codes survive API restarts. See Gotchas.
- Migrated and seeded once: `pnpm db:migrate && pnpm db:seed && pnpm db:seed:dev`
  from the repo root (builds `region`/`contracts` to `dist` first via the
  `predb:*` hooks - required, see the workspace-packages note in the root
  `CLAUDE.md`).
- This skill's own driver dependency, installed once and never touched again:
  `cd .claude/skills/run-themaithil && npm install`. Self-contained - not part of
  the pnpm workspace (see this directory's `package.json`).

## Run

The root `package.json` already wires `pnpm dev` to `turbo run dev`, which starts
**both** apps together (`turbo.json`'s `dev` task is `persistent: true`, and
builds `region`/`contracts` first via `dependsOn: ["^build"]`) - one command,
not two:

```bash
pnpm dev > /tmp/dev.log 2>&1 &
until curl -sf http://localhost:3000/readyz >/dev/null 2>&1 && curl -sf http://localhost:3001 >/dev/null 2>&1; do sleep 1; done
```

Prefer this. Fall back to starting them separately only when you need to bounce
just ONE app without disturbing the other (e.g. after editing only
`apps/web`, mid-debugging):

```bash
(cd apps/api && pnpm dev > /tmp/api.log 2>&1 &)
(cd apps/web && pnpm dev > /tmp/web.log 2>&1 &)
until curl -sf http://localhost:3000/readyz >/dev/null 2>&1 && curl -sf http://localhost:3001 >/dev/null 2>&1; do sleep 1; done
```

**Stop cleanly - this needs three steps, not one, or it leaves orphans:**

```bash
lsof -ti :3000 -sTCP:LISTEN | xargs -r kill -9
lsof -ti :3001 -sTCP:LISTEN | xargs -r kill -9
pkill -9 -f "turbo run dev"    # only needed after the single `pnpm dev` form
```

The third line is not optional if you started with `pnpm dev`. Tested directly:
the PID captured from `pnpm dev > log &` (`$!`) is the **shell wrapper**, not
turbo - killing it does nothing to the real process tree, same wrapper-PID trap
`main.ts`'s own EADDRINUSE message already warns about, one layer further up
(shell → pnpm → turbo → tsx/next). And killing by PORT alone frees both `:3000`
and `:3001` but leaves turbo's own orchestrator process running uselessly in the
background - confirmed via `ps aux`, it does not exit on its own once its
children die. Do all three lines every time.

## Demo accounts

OTP is always `123456` in dev (`OTP_DEV_BYPASS=true`) - or use `driver.mjs`'s
`login` command, which reads the real one-time code back from the API response
so it never depends on that flag's value.

| Phone | Role |
|---|---|
| `9830012345` | Devotee (Debarati Sen) |
| `9830000101`, `9830000102`, `9876543211` | Purohit (Kolkata's 4 verified purohits) |
| `9876543212` | Admin |

**Only Kolkata has purohit supply.** Every other city in the picker is a real,
fully-functional region (panchang, muhurat computation, catalogue) with zero
verified purohits, so any booking search there correctly returns "no pandit
free" - that's accurate, not a bug. Don't burn time debugging it; switch to
Kolkata.

## Drive

```bash
node .claude/skills/run-themaithil/driver.mjs
```

It's a REPL: type a command, see the result, type the next one. For one-shot
scripted runs, pipe a whole script to stdin (commands run strictly in order,
each waiting for the previous to finish - safe to pipe a multi-step flow):

```bash
cat > /tmp/flow.txt << 'EOF'
launch
nav /book?browse=1
login 9830012345
wait-text Satyanarayan
click-role button ^Select$
wait-text Choose a date
eval document.querySelectorAll('.daychip')[0]?.click()
wait .slotgrid
eval document.querySelectorAll('.slot')[0]?.click()
wait-text pandits are free
ss 01-options
EOF
node .claude/skills/run-themaithil/driver.mjs < /tmp/flow.txt
```

For interactive debugging, run it under `tmux` and `send-keys` one command at a
time so you can react to each result before sending the next - same commands,
same session, no relaunch cost between steps.

### Commands

| command | what it does |
|---|---|
| `launch` | start headless chromium |
| `nav <path-or-url>` | navigate; a bare path like `/book` resolves against `:3001` |
| `login <phone>` | the fast path - OTP request+verify against the real API, tokens injected into localStorage, page reloaded. Must run after `launch`/`nav` (localStorage is origin-scoped). |
| `ss [name]` | screenshot → `/tmp/shots/<name>.png` (override dir: `SCREENSHOT_DIR`) |
| `click <css-sel>` | click via Playwright's own selector engine |
| `click-text <text>` | click first element containing this text - **ambiguous on this app**, see Gotchas |
| `click-role <role> <name-regex>` | click by ARIA role + accessible name, e.g. `click-role button ^Select$` - prefer this over `click-text` |
| `fill <css-sel> <value>` | fill an input |
| `type <text>` / `press <key>` | raw keyboard input |
| `wait <css-sel>` | wait for a selector, 15s timeout |
| `wait-text <text>` | wait for text to appear, 15s timeout |
| `eval <js>` | evaluate in the page, print JSON |
| `text [css-sel]` | print innerText (whole body if no selector) |
| `url` | print the current page URL |
| `quit` | close the browser, exit |

## Gotchas

- **Stopping `pnpm dev` needs the `pkill -f "turbo run dev"` line too**, not just
  the two port kills - see Run above. Skipping it leaves turbo's own
  orchestrator process running with nothing left to orchestrate.
- **Stale `.next` webpack chunks** ("Cannot find module './NNN.js'", or a
  completely unstyled page). `next dev`'s chunk manifest drifts after many
  hot-reloads across a long session. Fix: kill the web server, `rm -rf
  apps/web/.next`, restart. Don't bother diagnosing further - it's never the app.
- **Orphaned `tsx watch` processes on :3000.** `tsx watch` does NOT exit when its
  child fails to bind a busy port - it just logs and keeps watching, so repeated
  `pnpm dev` attempts silently accumulate zombies and the server answering
  requests may not be the one whose logs you're reading (see the root
  `CLAUDE.md`). If `pnpm dev` logs `EADDRINUSE` even after you killed the port's
  listener, there's more than one watcher alive: `ps aux | grep "tsx watch"` and
  kill every PID, not just the current port holder.
- **Redis is real and persistent, not in-memory.** Heavy testing (many OTP
  requests, many bookings) accumulates real rate-limit and OTP state in Redis
  that outlives an API restart. If logins or bookings start failing with
  `RATE_LIMITED` for no reason you just caused, that's why: `redis-cli FLUSHDB`
  (safe - this instance holds only rate limits, OTP codes and slot holds, nothing
  durable; real data is in Postgres).
- **OTP-request rate limit is 5/hour per IP, not per phone.** Testing multiple
  demo accounts back-to-back from one machine shares one budget and exhausts it
  fast. Expected, not a bug - use `driver.mjs login`'s use of the real returned
  code rather than assuming `123456` always works, and `FLUSHDB` if you need a
  clean slate.
- **Two "Review and book" buttons exist in the DOM simultaneously** on `/book`
  once a slot is chosen - the desktop options card and the always-rendered
  mobile sticky CTA (hidden by CSS `display:none` above 980px, but Playwright
  still sees it in the DOM). `click-role button ^Review and book$` will error
  "strict mode violation, multiple elements"; use `page.getByRole(...).first()`
  semantics - i.e. accept either, or narrow with `.first()` in a custom `eval`.
- **`click-text` matches substrings anywhere in the DOM**, including nav chrome -
  e.g. `click-text Select` hits the header's "Select your city" before it
  reaches a ritual card's "Select" button. Prefer `click-role` with an anchored
  regex (`^Select$`) whenever the button text is short and generic.
