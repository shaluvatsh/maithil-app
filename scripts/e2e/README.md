# End-to-end driver

The Maithil is two servers sharing one Postgres and one Redis: `apps/api` (NestJS,
`:3000`) and `apps/web` (Next.js, `:3001`). Unit tests catch structure, not
appearance — nothing about layout, spacing, or whether a control is reachable on a
phone is verified by a test. This directory drives the real app in a real browser so
those things can be seen.

It is a small Playwright REPL, self-contained and deliberately **not** part of the
pnpm workspace. All paths below are relative to the repo root.

## Prerequisites (once)

- Postgres running locally with a `themaithil` database. The repo-root `.env` should
  already point `DATABASE_URL` at it (Homebrew Postgres has no password by default:
  `postgres://$(whoami)@localhost:5432/themaithil`).
- Redis running locally (`redis-server`), matching `.env`'s `REDIS_URL`. **This is a
  real persistent instance, not an in-memory fallback** — rate-limit counters and OTP
  codes survive API restarts. See Gotchas.
- Migrated and seeded once, from the repo root:
  `pnpm db:migrate && pnpm db:seed && pnpm db:seed:dev`
  (the `predb:*` hooks build `region`/`contracts` first — required, see the
  workspace-packages note in `CONTRIBUTING.md`).
- This driver's own dependency, installed once:
  `cd scripts/e2e && npm install`.

## Run the app

`pnpm dev` starts **both** apps together (`turbo.json`'s `dev` task is
`persistent: true` and builds `region`/`contracts` first via `dependsOn: ["^build"]`):

```bash
pnpm dev > /tmp/dev.log 2>&1 &
until curl -sf http://localhost:3000/health >/dev/null 2>&1 \
   && curl -sf http://localhost:3001 >/dev/null 2>&1; do sleep 1; done
```

Prefer that. Start them separately only to bounce one app without disturbing the
other:

```bash
(cd apps/api && pnpm dev > /tmp/api.log 2>&1 &)
(cd apps/web && pnpm dev > /tmp/web.log 2>&1 &)
```

**Stopping needs three steps, not one, or it leaves orphans:**

```bash
lsof -ti :3000 -sTCP:LISTEN | xargs -r kill -9
lsof -ti :3001 -sTCP:LISTEN | xargs -r kill -9
pkill -9 -f "turbo run dev"    # only needed after the single `pnpm dev` form
```

The third line is not optional. The PID from `pnpm dev > log &` (`$!`) is the **shell
wrapper**, not turbo — killing it does nothing to the real process tree (shell → pnpm
→ turbo → tsx/next). Killing by port frees `:3000` and `:3001` but leaves turbo's
orchestrator running with nothing to orchestrate; it does not exit on its own.

## Demo accounts

OTP is always `123456` in dev (`OTP_DEV_BYPASS=true`) — or use the driver's `login`
command, which reads the real one-time code back from the API response and so never
depends on that flag.

| Phone | Role |
|---|---|
| `9830012345` | Devotee (Debarati Sen) |
| `9830000101`, `9830000102`, `9876543211` | Purohit (Kolkata's verified purohits) |
| `9876543212` | Admin |

**Only Kolkata has purohit supply.** Every other city in the picker is a real,
fully-functional region (panchang, muhurat computation, catalogue) with zero verified
purohits, so a booking search there correctly returns "no pandit free". That is
accurate, not a bug — switch to Kolkata rather than debugging it.

## Drive it

```bash
node scripts/e2e/driver.mjs
```

A REPL: type a command, see the result, type the next. For scripted runs, pipe a
whole script to stdin — commands run strictly in order, each waiting for the previous
to finish:

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
node scripts/e2e/driver.mjs < /tmp/flow.txt
```

Each invocation is one browser session; a piped script must therefore start with
`launch` and contain the whole flow. For step-by-step debugging, run it under `tmux`
and `send-keys` one command at a time to react to each result without paying the
relaunch cost.

### Commands

| command | what it does |
|---|---|
| `launch` | start headless chromium |
| `nav <path-or-url>` | navigate; a bare path like `/book` resolves against `:3001` |
| `login <phone>` | OTP request + verify against the real API, tokens injected into localStorage, page reloaded. Must run after `launch`/`nav` — localStorage is origin-scoped. |
| `ss [name]` | screenshot → `/tmp/shots/<name>.png` (override with `SCREENSHOT_DIR`) |
| `click <css-sel>` | click via Playwright's selector engine |
| `click-text <text>` | click first element containing this text — **ambiguous on this app**, see Gotchas |
| `click-role <role> <name-regex>` | click by ARIA role + accessible name, e.g. `click-role button ^Select$`. Prefer this. |
| `fill <css-sel> <value>` | fill an input |
| `type <text>` / `press <key>` | raw keyboard input |
| `wait <css-sel>` | wait for a selector, 15s timeout |
| `wait-text <text>` | wait for text to appear, 15s timeout |
| `eval <js>` | evaluate in the page, print JSON |
| `text [css-sel]` | print innerText (whole body if no selector) |
| `url` | print the current page URL |
| `quit` | close the browser, exit |

## Gotchas

- **Stale `.next` webpack chunks** — "Cannot find module './NNN.js'", or a completely
  unstyled page because the CSS bundle the HTML references 404s. `next dev`'s chunk
  manifest drifts after many hot reloads in a long session. Fix: stop the web server,
  `rm -rf apps/web/.next`, restart. It is never the application code.
- **`pnpm build` while `pnpm dev` is up.** This was the most confusing failure in the
  set: `build` rewrites `packages/*/dist`, the API's watcher restarted on it and
  sometimes did not come back, leaving the web server answering on :3001 with no API
  behind it — which presents as "the database is down" when the database is fine.
  `apps/api`'s `dev` script now excludes `packages/*/dist` from the watcher, so this
  should not recur. If it does, check :3000 and :3001 separately before suspecting
  Postgres. The cost of the fix: **restart the API by hand after editing
  `packages/region` or `packages/contracts`.**
- **Orphaned `tsx watch` processes on :3000.** `tsx watch` does not exit when its
  child fails to bind a busy port — it logs and keeps watching, so repeated `pnpm dev`
  attempts silently accumulate zombies, and the server answering the browser may not
  be the one whose logs you are reading. If `EADDRINUSE` persists after killing the
  port's listener, more than one watcher is alive: `ps aux | grep "tsx watch"` and
  kill every PID.
- **Redis is real and persistent.** Heavy testing accumulates rate-limit and OTP state
  that outlives an API restart. If logins or bookings start failing with
  `RATE_LIMITED` for no reason you just caused, that is why: `redis-cli FLUSHDB` is
  safe — this instance holds only rate limits, OTP codes and slot holds. Durable data
  is in Postgres.
- **The OTP-request rate limit is 5/hour per IP, not per phone.** Testing several demo
  accounts back-to-back from one machine shares one budget and exhausts it quickly.
  Expected, not a bug.
- **Two "Review and book" buttons exist in the DOM at once** on `/book` once a slot is
  chosen: the desktop options card and the always-rendered mobile sticky CTA (hidden
  by CSS above 980px, but still in the DOM). `click-role button ^Review and book$`
  fails with "strict mode violation"; narrow with `.first()` in an `eval`.
- **`click-text` matches substrings anywhere**, including nav chrome — `click-text
  Select` hits the header's "Select your city" before a ritual card's "Select" button.
  Prefer `click-role` with an anchored regex (`^Select$`) for short, generic labels.
