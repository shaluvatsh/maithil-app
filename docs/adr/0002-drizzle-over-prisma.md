# ADR 0002 — Drizzle ORM, not Prisma

Status: Accepted · 31 Jul 2026

## Context
The money paths need `SELECT ... FOR UPDATE`, multi-row locks across a contiguous slot span,
deferred constraint checks on the ledger, and readable SQL migrations we can hand to an auditor.

## Decision
Drizzle ORM + `drizzle-kit` for migration generation, with hand-edited SQL where needed.

## Rationale
- Row locking is first-class (`.for('update')`); in Prisma it requires `$queryRaw`, which
  drops type safety exactly where we least want to lose it.
- Migrations are plain reviewable `.sql`. Prisma's shadow-database flow is friction on free-tier Postgres.
- No Rust query engine binary — smaller image, faster cold start, works on any host.

## Consequences
- Less mature ecosystem, thinner docs than Prisma. Accepted.
- We write more SQL by hand. For a money system this is a feature.
