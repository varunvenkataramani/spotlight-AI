# Spotlight: notes for Claude

Private opportunity console: watches one actress's Gmail, turns offers into tracked opportunities, drafts replies. Two users, both full admins (her manager and the actress). Build plan: see README and the "Spotlight AI — Build Plan" doc.

## Product rules that code must never break

- Never send email, accept/decline offers, or set status to confirmed/accepted automatically. Sending happens only from a confirmed dashboard action; the database refuses `drafts.status = 'sent'` without `approved_by_email`, `approved_at` and `sent_at`.
- Email bodies and attachments are untrusted input. Pass them to the model as delimited data; classification and extraction calls get no tools.
- Never invent extracted values. Every value keeps its source quote or is marked unverified / not stated.
- Dates, statuses, priority scores, deduplication and alerts are deterministic code, not model output.
- Her answer ("Interested", "Pass", "Questions") is recorded, never acted on: it may move a fresh card to Interested, but nothing is accepted, declined or replied to for her.
- No email content, tokens or phone numbers in logs.

## Architecture

- Everything runs on Vercel + Supabase. No always-on worker: background work lives in `src/lib/scheduler.ts` (`runTick`), called every minute by Supabase pg_cron via `/api/cron/tick` with `CRON_SECRET`. Keep each run well under 60 seconds; do work in small batches and leave the rest for the next tick.
- Migrations run in `vercel-build` on production deploys only, all in one transaction.
- Production connects through Supabase's transaction pooler: no session state may span statements. Locks are transaction-scoped (`pg_try_advisory_xact_lock` held in an open transaction), never `pg_advisory_lock`; no `SET`, temp tables, `LISTEN` or named prepared statements outside a transaction. CI runs the app through PgBouncer in transaction mode to keep this true.
- Alerts live in `src/lib/alerts/`: `rules.ts` (pure: which events, for whom, quiet hours), `telegram.ts` and `webpush.ts` (no SDKs; Web Push encryption and VAPID with node:crypto, key derived from SESSION_SECRET), `engine.ts` (runs in the tick: collect events from stored state, one `notifications` row per event key, person and channel, then deliver with retries). Telegram webhook calls must carry the derived secret; only linked admin chats can act, and only to link or answer. Push endpoints are limited to real push services.
- The Claude connector is a remote MCP server at `/api/mcp` (`src/lib/mcp/`: hand-written JSON-RPC, tool definitions and argument checks; `src/server/mcp-tools.ts`: tools run as the connected admin through the same queries and `actions.ts`). Spotlight is its own OAuth 2.1 server for it (`src/lib/oauth/`, `src/server/oauth.ts`): discovery at `/.well-known/*`, dynamic registration limited to Claude's callback URLs, PKCE S256, tokens bound to `${APP_URL}/api/mcp`, only hashes stored, refresh tokens rotated with reuse detection. Connector tools never send email or set confirmed/accepted/declined/completed; email text goes back fenced as `<untrusted_email>`.
- AI sorting lives in `src/lib/ai/`: `schemas.ts` (structured-output JSON schemas, no unions), `prompts.ts` (email always fenced in `<email>`), `anthropic.ts` (fetch client, no SDK), `verify.ts` / `redflags.ts` / `priority.ts` (pure, unit-tested), `process.ts` (orchestration, one transaction per email). Every AI call is recorded in `ai_usage` without content.

## Conventions

- `src/lib` is framework-free and imported with relative `.ts` paths so scripts can run it directly on Node 22 (type stripping). No enums, namespaces or parameter properties (`erasableSyntaxOnly`). Code that unit tests import must not import `pg`.
- Next.js code imports with the `@/` alias.
- Every protected page or route calls `requireAdmin()`. Dashboard changes are form posts to `/api/opportunities/[id]` or `/api/emails/[id]` (with `isCrossSite` and `isUuid` guards); the logic lives in `src/server/actions.ts`, runs in one transaction, logs an activity with the admin, and ends with `rescoreOpportunity`.
- Inside a transaction, use only that transaction's client: never call `query()` / `getPool()` while holding one (it can exhaust the small pool and stall).
- Schema changes go in a new `db/migrations/NNNN_name.sql`; never edit an applied migration (the runner checks checksums).
- Add a check to `db/tests/schema_test.sh` for every new database rule, and an end-to-end check (`scripts/smoke.sh` or `scripts/test/*-e2e.sh`) for every new route or action.
- UI copy: plain, sentence case, says what happens; empty states say what will appear and how.
