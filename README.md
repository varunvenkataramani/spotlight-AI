# Spotlight

A private opportunity console for an actress and her manager. Spotlight watches her Gmail, turns offers into tracked opportunities, and drafts replies that only a person can send.

The full product plan lives in the build plan doc. This README covers running and deploying the code.

## How it runs

Everything runs on **Vercel** with a **Supabase** Postgres database; there is no separate server to keep alive.

- **Pages and API routes** run on Vercel.
- **Background work** (Gmail sync, AI processing, reminders) runs in `/api/cron/tick`, which Supabase's built-in scheduler (pg_cron) calls every minute with a shared secret. A database lock stops two runs from overlapping.
- **Gmail push notifications** (from Milestone 2) go straight to a webhook route on Vercel.
- **Database migrations** run automatically on every production deploy (`vercel-build`).

## What works today (Milestone 1)

- Google sign-in for exactly two admins (allow-list), with PKCE, signed httpOnly cookies, and a re-check on every request.
- The complete database schema, with safety rules enforced by Postgres itself: one row per Gmail message, an append-only activity log, drafts that can't be marked sent without a recorded approval, and de-duplicated alerts.
- Dashboard shell: Overview (live counts from the database), Opportunities, Needs review and Settings (system status and admins). Empty states say what will appear and when.
- Scheduled background runs every minute; Settings and `/api/health` show if they stop.
- Automated checks on every push (see `.github/workflows/ci.yml`).

Not built yet: Gmail connection (Milestone 2), the AI pipeline (3), the full dashboard (4), replies and alerts (5), and the Claude connector (6).

## Project layout

| Path | What it is |
| --- | --- |
| `src/app` | Next.js pages and API routes |
| `src/lib` | Framework-free code: config, database, encryption, sign-in checks, scheduled work |
| `src/server` | Server-only helpers used by pages: session, queries |
| `db/migrations` | SQL migrations, applied in order by `npm run migrate` |
| `db/setup` | One-time Supabase setup (the scheduler) |
| `db/tests` | Checks that the database rules hold |
| `scripts/` | Migration runner and the end-to-end smoke test |

## Setup

### 1. Google Cloud

1. In [Google Cloud Console](https://console.cloud.google.com), create a project.
2. Open **Google Auth Platform** (search for it in the top bar). Set it up as **External**, leave it in **Testing**, and under **Audience > Test users** add both admin Google accounts and the Gmail being connected.
3. Enable the **Gmail API** and **Cloud Pub/Sub API** (used from Milestone 2).
4. After the first Vercel deploy (step 3), open **Google Auth Platform > Clients > Create client**, type **Web application**, with the authorised redirect URI `https://YOUR-APP.vercel.app/api/auth/callback`. Copy the client ID and secret into Vercel.

### 2. Database (Supabase)

Create a Supabase project. Under **Connect > Direct > Session pooler**, copy the connection string (port **5432**) into `DATABASE_URL`. Optionally put the database's SSL certificate (Project settings > Database) in `DATABASE_CA_CERT` so the server certificate is fully verified.

Don't create tables yourself: the first production deploy applies `db/migrations` automatically.

### 3. Vercel

Import the GitHub repository and set the environment variables below (Production). The first deploy creates the tables and gives you the web address for step 1.4 and `APP_URL`.

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public address, e.g. `https://spotlight-xyz.vercel.app` (no trailing slash) |
| `DATABASE_URL` | Supabase session-pooler connection string |
| `DATABASE_CA_CERT` | Optional: CA certificate for full TLS verification |
| `ADMIN_EMAILS` | The two admin Google accounts, comma-separated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client from step 1.4 |
| `SESSION_SECRET` | Signs session cookies |
| `TOKEN_ENCRYPTION_KEY` | Encrypts Gmail tokens (used from Milestone 2) |
| `CRON_SECRET` | Shared secret for the scheduler's calls to `/api/cron/tick` |

Each secret is 32 random bytes in base64, a different value for each. Generate one with `npm run gen:secret`, or in any browser console:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

Vercel's Hobby plan is for personal, non-commercial use. Move to Pro before running Spotlight for a client.

### 4. The scheduler (once)

Open `db/setup/supabase_scheduler.sql`, replace `PASTE_CRON_SECRET_HERE` and `YOUR-APP.vercel.app`, and run it in **Supabase > SQL Editor**. Within two minutes, **Settings** in Spotlight shows background jobs as running and `/api/health` answers `"ok": true`.

### 5. Run locally (optional)

```bash
cp .env.example .env.local   # fill it in; APP_URL=http://localhost:3000
npm install
npm run migrate
npm run dev
# trigger a background run by hand:
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick
```

For local sign-in, add `http://localhost:3000/api/auth/callback` to the Google client's redirect URIs.

## Checks

```bash
npm test               # unit tests: encryption, cookies, allow-list, scheduler secret, Google sign-in
npm run test:schema    # database rule checks (fresh migrated database in DATABASE_URL)
npm run typecheck
bash scripts/smoke.sh  # after npm run build: starts the app and probes it end to end
```

All of these run on every push in GitHub Actions.

## Safety rules (non-negotiable)

- Nothing is sent, accepted or agreed without an admin clicking to approve it.
- Email content is untrusted data, never instructions.
- Extracted facts carry their source quote; missing information is marked missing, never guessed.
- Tokens are encrypted at rest; no email bodies, tokens or phone numbers go into logs.
