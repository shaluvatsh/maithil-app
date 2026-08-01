# ADR 0010 — Manual KYC review in R1

Status: Accepted · 31 Jul 2026

## Decision
No DigiLocker and no automated penny-drop in R1. The purohit uploads documents; an admin
reviews them against a checklist and approves.

## Rationale
100 purohits over 90 days is roughly one verification per day. A human does that in ten
minutes. The two integrations cost ~2 weeks of engineering plus onboarding lead time, to
automate a process that is not yet a bottleneck — and the verification *judgement* (is this
person a credible purohit, is the lineage real) is not automatable anyway.

## What we still build
`kyc_records` with the final schema, so switching to DigiLocker later is a new `provider`
value and a webhook, not a migration. Bank verification is a ₹1 test payout with the purohit
confirming receipt in-app — same signal as penny-drop, no vendor.

## Trigger to automate
More than 10 verifications/day, or the first fraudulent-credential incident.

## Non-negotiable regardless
No raw Aadhaar number is ever stored. We store the last four digits and a document reference.
This holds in the manual flow too — the reviewer sees the document, records the reference,
and the image is deleted from R2 after approval + 30 days.
