# ADR 0005 — Transactional outbox for domain events

Status: Accepted · 31 Jul 2026

## Context
The original design publishes domain events to Redis Streams/BullMQ from inside service
methods. A Redis publish is not part of the Postgres transaction. A crash between COMMIT and
PUBLISH leaves a booking `confirmed` with no kit order and no escrow entries. The reverse
ordering duplicates side effects.

## Decision
Write the event row to `outbox` inside the same transaction as the state change.
A relay polls `outbox WHERE published_at IS NULL ORDER BY id` (with `SKIP LOCKED`) and pushes
to BullMQ. Delivery is at-least-once; every consumer is idempotent on `event_id`.

## Consequences
- Adds ~200 ms of latency to side effects. Irrelevant for notifications and kit orders.
- The `outbox` table is the audit trail of intent, which turns out to be useful in disputes.
- Consumers MUST be idempotent. This is a review checklist item, not a hope.
