# ADR 0007 — Hosting: free tier now, AWS never until it hurts

Status: Accepted · 31 Jul 2026

## Decision (R1)
| Concern | Choice | Cost |
|---|---|---|
| Postgres | **Neon** free tier (0.5 GB, scale-to-zero, branching) | ₹0 |
| Redis | **Upstash** free tier (10k cmd/day) | ₹0 |
| API host | **Fly.io** shared-cpu-1x, 1 machine, Mumbai (`bom`) region | ~₹0–400/mo |
| Object storage | **Cloudflare R2** free tier (10 GB, no egress fee) | ₹0 |
| Errors | **Sentry** free tier | ₹0 |
| CI | GitHub Actions free minutes | ₹0 |

Fly's `bom` region keeps us in-country, which matters for DPDP data-residency comfort and
for latency to Razorpay and the panchang provider.

Local dev is `docker compose up` — identical Postgres and Redis versions, no cloud needed.

## Rationale
At 11 bookings/day the ECS + RDS + ElastiCache + CloudFront + OpenSearch stack in the original
plan costs roughly a week of setup and a meaningful monthly bill to serve traffic a single
container handles without noticing. Terraform, OpenSearch and the full OpenTelemetry pipeline
are deferred until there is traffic worth observing.

## Migration trigger
Move to AWS ap-south-1 when any of: sustained >5 req/s, Postgres >10 GB, a second engineer
is on-call, or an enterprise/temple contract demands a VPC. The module boundaries in ADR 0001
mean this is a deployment change, not a rewrite.

## Caveat
Neon free tier scales to zero and cold-starts in ~500 ms. Acceptable for staging. Before
taking real payment traffic, move Postgres to a paid always-on plan (~$19/mo). This is a
launch checklist item, not a Phase-0 one.
