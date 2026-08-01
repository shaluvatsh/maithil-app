# ADR 0008 — R1 scope for a 1–2 engineer team

Status: Accepted · 31 Jul 2026

## Context
The handoff plans 20 weeks across four phases. That plan implies 5–8 engineers. With 1–2, the
same scope is roughly 40–50 weeks — long enough that the market answer arrives after the money
runs out. The correct response is to cut scope, not to accept the estimate.

## Decision — what R1 is

**In:** phone-OTP auth · 25 Kolkata rituals with BOMs and Bengali content · dual-school
panchang · purohit onboarding with **manually reviewed** KYC · slot availability · search ·
the full booking state machine · digital payments via Razorpay Route · **cash mode** ·
double-entry ledger · OTP start/complete · weekly payouts · WhatsApp + SMS notifications ·
reviews · a thin admin console.

**Out of R1, in rough order of when to reconsider:**

| Cut | Why | Interim |
|---|---|---|
| Partner-vendor kits, courier integration, vendor portal, QC gate | ~4 weeks for a pipeline serving ~4 deliveries/day at launch | Samagri Option A only — purohit brings, priced from the BOM |
| DigiLocker + penny-drop automation | Two integrations with onboarding lead times | Admin reviews uploaded documents by hand. 100 purohits is a hand-reviewable number |
| E-puja / LiveKit | Whole second product surface | — |
| Subscriptions / UPI Autopay | Mandate handling is its own compliance surface | Manual rebook in one tap |
| Referrals | Fraud rules cost more than the growth is worth pre-PMF | — |
| `devotee-web` SEO site | Third frontend | Deep links from the app |
| 1P kits, iOS app, Terraform/AWS | Post-pilot decisions | — |

**Cash stays in.** It is the thesis. Under the corrected exception-only dues model
(ADR 0004) cash mode is *simpler* to build than digital-token-balance mode — it is the branch
where we do not charge the balance. Cutting it would be cutting the reason the product exists.

## Revised plan

| Phase | Weeks | Outcome |
|---|---|---|
| 0 — Foundations + procurement | 1–4 | Scaffold, contracts, schema, auth, Kolkata catalogue seeded |
| 1 — Core loop, digital only | 5–16 | First real booking end to end |
| 2 — Cash + surge + admin | 17–24 | Pilot-ready with 20 purohits |
| 3 — Hardening + UAT + soft launch | 25–28 | Public in Kolkata |

28 weeks for one engineer, ~20 for two. Compared against the handoff's 20 weeks, the honest
difference is that this one has a resourcing assumption written down.

## P0-0 — external procurement, starts week 1, founder-owned

Not an engineering task, and the most common way plans like this slip. Every item below has a
lead time in weeks and gates Phase 1 or 2:

incorporation + GST · Razorpay Route application (new-merchant settlement holds run 7–14 days) ·
WhatsApp BSP account (template approval 1–2 weeks *per batch*, and there are six critical
templates) · panchang API subscription · **consulting purohit on retainer** · CA engaged on the
s.194-O cash treatment and the GST s.9(5) question · legal review of escrow hold duration
against the RBI T+1 settlement rule.
