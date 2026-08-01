# Next steps

Ordered. Everything here assumes the ADRs in `docs/adr/` are agreed.

## Blocking, and not engineering work

**P0-0 — external procurement. Start week 1, founder-owned.**
Every item has a lead time in weeks and gates Phase 1 or 2:

- [ ] Incorporation + GST registration
- [ ] Razorpay Route application — note new-merchant settlement holds run 7–14 days
- [ ] **Confirm maximum escrow hold duration against the RBI T+1 settlement rule.**
      Long-lead bookings (festival pre-booking, a muhurat a month out) may not be
      holdable. If holds are capped, the balance must be charged at T-2 instead.
      Resolve before writing any payment code.
- [ ] WhatsApp BSP account — template approval is 1–2 weeks *per batch*, six templates
- [ ] Prokerala (or equivalent) subscription for Bisuddha Siddhanta data
- [ ] **Consulting purohit on retainer** — owns annual Gupta Press entry, BOM validation,
      Bengali term sign-off. A named recurring role, not a review meeting.
- [ ] CA engaged on two questions: the s.194-O cash treatment implemented in
      `settlement.ts`, and whether GST s.9(5) e-commerce-operator liability applies
      given most purohits are below the registration threshold.
- [ ] Content: 25 ritual descriptions × 3 languages, ~400 BOM line items.
      This blocks P0-4 and is the thing most likely to be forgotten.

## Engineering — done

1. ~~Auth module~~ — phone OTP, JWT access/refresh, role guards, `MeResponse`.
2. ~~HTTP layer~~ — controllers, zod pipe, `DomainError` → status mapping, idempotency.
3. ~~Availability materialisation~~ — 120 days, the same `BOOKING_HORIZON_DAYS` the
   panchang job will use.
4. ~~Booking flow~~ — draft → hold → submit → accept → confirm → start → complete,
   with slot locking, travel buffers, refunds.
5. ~~Outbox relay~~ — poll, publish, mark, retry, park after 10 attempts.
6. ~~Settlement on completion~~ — wired to `LedgerService.post` in the same transaction.

## Engineering — next, in order

1. **Razorpay client + webhook handler.** The confirm path already exists as
   `BookingService.confirmOnTokenCapture(...)`; the webhook needs to verify the
   signature, insert into `webhook_events` (unique on provider event id), and call it.
   Blocked on the escrow-hold answer above.
2. **Panchang provider client + nightly job**, per (city × school). Bisuddha from the
   API; Gupta Press from an admin entry screen. Compute `schools_disagree` in the job
   and layer the abhijit/rahu annotations onto `AvailabilityService.forRange`.
3. **Search and matching** — the ranking query, with the cold-start boost below.
   Use haversine on `base_lat/base_lng` for the proximity term; call the Maps
   Distance Matrix **once**, at confirmation, for the travel fee and buffer. Calling
   it per search result is the cost bomb flagged in the review.
4. **Notification workers** — outbox consumer → WhatsApp BSP with SMS fallback.
   `notification_templates` is seeded with the six critical Bengali templates.
5. **Weekly payout job** — gross − open dues − TDS − `tds_carry`. Then earnings.
6. **Admin console** — verification queue first; it is what unblocks purohit onboarding.

## Design work still owed

- **Priority score.** `pandit_profiles.priority_score` has a column and no formula. Needs:
  a Bayesian-prior rating so two 5-star reviews do not outrank forty 4.7s, plus the
  `new_supply_boost_remaining` cold-start mechanism (guaranteed impressions for the
  first 20 requests). Without this new purohits never rank, never earn a rating, and churn.
- **Offline completion.** The captured design is: offline capture records *intent*
  (`offline_capture_at`, GPS, cash amount) and the booking does not reach `completed`
  until the server validates the OTP. Settlement never fires from cached data. The
  purohit-facing UX for "pending sync" still needs designing.
- **DPDP deletion vs GST retention.** A deletion request cannot remove invoices or
  ledger rows. `users.deleted_at` is the tombstone; the pseudonymisation policy —
  which columns get scrubbed, which survive — needs writing and legal review.
- **Multi-day rituals.** Biye spans Gaye Holud / Biye / Bou Bhaat. R1 models this as
  linked bookings via `parent_booking_id`. Validate with the consulting purohit that
  this matches how purohits actually quote for a wedding.

## Metrics worth fixing before launch

The 90-day target of 100 purohits and 1,000 bookings implies **3.3 bookings per purohit
per month**, against a persona who performs 15–40. That is 10–20% of their work, for a
15% cut and a calendar to maintain. Consider recruiting 30 purohits at 11/month instead —
real income for them, and a fill rate that is achievable rather than aspirational.

Also add **repeat-booking rate through the platform** to the metric set. The token
protects booking one; nothing protects booking two, and you want to measure the leak
rather than discover it in month six.
