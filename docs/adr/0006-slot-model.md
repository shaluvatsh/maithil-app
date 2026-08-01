# ADR 0006 — Contiguous multi-slot bookings

Status: Accepted · 31 Jul 2026

## Context
Four fixed 3-hour slots with a single `slot_idx` on the booking cannot represent a Bengali
Biye, an Upanayan, or a full Durga Puja — all of which are in the launch catalogue.
Namkaran at 45 minutes wastes a 3-hour block.

Also: the published slot boundaries leave a 30-minute gap between slots. Cross-Kolkata travel
routinely exceeds that, so effective capacity is 2–3 slots/day, not 4. The income model must
use the real number.

## Decision
`bookings.slot_span INT NOT NULL DEFAULT 1` — a booking occupies `slot_idx .. slot_idx+span-1`.
Span is derived from `rituals.duration_min` plus a travel allowance, and can be overridden by
the pandit. Confirmation locks all N `availability` rows `FOR UPDATE` in one transaction,
ordered by `slot_idx` to avoid deadlock.

Also denormalised onto `bookings`: `slot_start_at` / `slot_end_at` as `TIMESTAMPTZ`.
Every deadline in the product (refund tiers at 24/48 h, BOM lock at T-48 h, T-1 reminders,
the 2 h accept window) is relative to slot start. Without this column none of them is indexable.

## Deferred
Multi-**day** rituals (Biye across Gaye Holud / Biye / Bou Bhaat) are modelled in R1 as
separate linked bookings via `bookings.parent_booking_id`. A true multi-day entity waits for
pilot data.
