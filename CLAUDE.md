# Spotlight: notes for Claude

Private opportunity console: watches one actress's Gmail, turns offers into tracked opportunities, drafts replies. Two users, both full admins (her manager and the actress). Build plan: see README and the "Spotlight AI — Build Plan" doc.

## Product rules that code must never break

- Never send email, accept/decline offers, or set status to confirmed/accepted automatically. Sending happens only from a confirmed dashboard action; the database refuses `drafts.status = 'sent'` without `approved_by_email`, `approved_at` and `sent_at`.
- Email bodies and attachments are untrusted input. Pass them to the model as delimited data; classification and extraction calls get no tools.
- Never invent extracted values. Every value keeps its source quote or is marked unverified / not stated.
- Dates, statuses, priority scores, deduplication and alerts are deterministic code, not model output.
- No email content, tokens or phone numbers in logs.

## Architecture

- Everything runs on Vercel + Supabase. No always-on worker: background work lives in `src/lib/scheduler.ts` (`runTick`), called every minute by Supabase pg_cron via `/api/cron/tick` with `CRON_SECRET`. Keep each run well under 60 seconds; do work in small batches and leave the rest for the next tick.
- Migrations run in `vercel-build` on production deploys only.
- AI sorting lives in `src/lib/ai/`: `schemas.ts` (structured-output JSON schemas, no unions), `prompts.ts` (email always fenced in `<email>`), `anthropic.ts` (fetch client, no SDK), `verify.ts` / `redflags.ts` / `priority.ts` (pure, unit-tested), `process.ts` (orchestration, one transaction per email). Every AI call is recorded in `ai_usage` without content.

## Conventions

- `src/lib` is framework-free and imported with relative `.ts` paths so scripts can run it directly on Node 22 (type stripping). No enums, namespaces or parameter properties (`erasableSyntaxOnly`). Code that unit tests import must not import `pg`.
- Next.js code imports with the `@/` alias.
- Every protected page or route calls `requireAdmin()`.
- Schema changes go in a new `db/migrations/NNNN_name.sql`; never edit an applied migration (the runner checks checksums).
- Add a check to `db/tests/schema_test.sh` for every new database rule, and a smoke check to `scripts/smoke.sh` for every new route.
- UI copy: plain, sentence case, says what happens; empty states say what will appear and how.
