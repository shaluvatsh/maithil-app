# ADR 0001 — Modular monolith, single Node process

Status: Accepted · 31 Jul 2026

## Context
Launch target is ~11 bookings/day (1,000 in 90 days). Team is 1–2 engineers.

## Decision
One NestJS process, strict internal module boundaries, no network calls between modules.
Modules communicate only via the transactional outbox (ADR 0005) or via explicit
service interfaces registered in the Nest DI container.

Boundary rule, enforced by `eslint-plugin-boundaries`:
a module may import from `@/contracts`, `@/common`, `@/db`, and its own folder. Nothing else.
Cross-module reads go through a published `*.facade.ts`; cross-module writes go through events.

## Consequences
- Service extraction later is a build-config change, not a rewrite.
- No distributed tracing needed in R1; a request id in logs suffices.
- We accept that a bad deploy takes everything down. At this volume that is the right trade.

## Rejected
Microservices — no operational capacity on a 1–2 person team.
Serverless functions — cold starts fight the <3 s booking-confirm NFR, and long-lived
Postgres connections need a pooler we would rather not operate yet.
