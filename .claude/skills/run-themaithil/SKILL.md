---
name: run-themaithil
description: Build, run, and drive The Maithil app (NestJS API on :3000, Next.js web on :3001) against a real local Postgres/Redis. Use when asked to start the app, take a screenshot of it, test a booking/purohit/admin flow, or confirm a change works end to end (not just unit tests).
---

The driver and its full documentation live in the repository itself, at
`scripts/e2e/`, so they are available to every developer rather than only to an
assisted session.

**Read `scripts/e2e/README.md` first and follow it verbatim.** It carries the
prerequisites, the three-step stop sequence, the demo accounts, the command table and
the gotchas — all verified against this app.

Quick reference (details and caveats are all in that README):

```bash
# start both apps
pnpm dev > /tmp/dev.log 2>&1 &
until curl -sf http://localhost:3000/health >/dev/null 2>&1 \
   && curl -sf http://localhost:3001 >/dev/null 2>&1; do sleep 1; done

# drive a scripted flow (one browser session per invocation; start with `launch`)
node scripts/e2e/driver.mjs < /tmp/flow.txt

# stop — all three lines, every time
lsof -ti :3000 -sTCP:LISTEN | xargs -r kill -9
lsof -ti :3001 -sTCP:LISTEN | xargs -r kill -9
pkill -9 -f "turbo run dev"
```

This file is the only assistant-specific artefact in the repository. It is a pointer,
not a copy: deleting `.claude/` before production removes it without affecting
`scripts/e2e/`, which is the real tool.
