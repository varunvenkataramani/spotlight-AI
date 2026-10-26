# Spotlight

A private opportunity console for an actress and her manager. Spotlight watches her Gmail, turns offers into tracked opportunities, and drafts replies that only a person can send.

The full product plan lives in the build plan doc. This README covers running and deploying the code.

## What works today (Milestone 1)

- Google sign-in for exactly two admins (allow-list), with PKCE, signed httpOnly cookies, and a re-check on every request.
- The complete database schema, with safety rules enforced by Postgres itself: one row per Gmail message, an append-only activity log, drafts that can't be marked sent without a recorded approval, and de-duplicated alerts.
- Dashboard shell: Overview (live counts from the database), Opportunities, Needs review and Settings (system status and admins). Empty states say what will appear and when.
- An always-on background worker that checks in every minute; Settings and `/api/health` show if it stops.
- Automated checks on every push (see `.github/workflows/ci.yml`).

Not built yet: Gmail connection (Milestone 2), the AI pipeline (3), the full dashboard (4), replies and alerts (5), and the Claude connector (6).

## Project layout

| Path | What it is |
| --- | --- |
| `src/app` | Next.js pages and API routes |
| `src/lib` | Framework-free code: config, database, encryption, sign-in checks |
| `src/server` | Server-only helpers used by pages: session, queries |
| `worker/` | The background worker (`npm run worker`) |
| `db/migrations` | SQL migrations, applied in order by `npm run migrate` |
| `db/tests` | Checks that the database rules hold |
| `scripts/` | Migration runner and the end-to-end smoke test |

## Setup

You need Node.js 22.18 or newer and a Postgres 16 database (Supabase works).

### 1. Google sign-in client

1. In [Google Cloud Console](https://console.cloud.google.com), create a project (for example `spotlight`).
2. Open **APIs & Services > OAuth consent screen**. Choose **External**, fill in the app name and support email, and leave it in **Testing**.
3. Under **Test users**, add both admin Google accounts and the test Gmail.
4. Open **APIs & Services > Credentials > Create credentials > OAuth client ID**, type **Web application**.
5. Add these **Authorised redirect URIs**:
   - `http://localhost:3000/api/auth/callback` (local development)
   - `https://YOUR-DOMAIN/api/auth/callback` (production, once you have it)
6. Copy the client ID and client secret into your environment.

The Gmail API and Pub/Sub are added to the same project in Milestone 2.

### 2. Database

Create a Supabase project. In **Project settings > Database**, copy the connection string that uses port 5432 (direct or session pooler) into `DATABASE_URL`. Optionally download the SSL certificate and put its contents in `DATABASE_CA_CERT`, so the connection's certificate is fully verified.

Then apply the schema:

```bash
npm run migrate
```

It's safe to run on every deploy; it only applies new migrations.

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill it in. Generate the two secrets with:

```bash
npm run gen:secret   # run twice: once for SESSION_SECRET, once for TOKEN_ENCRYPTION_KEY
```

| Variable | Used by | Purpose |
| --- | --- | --- |
| `APP_URL` | web | Public address, no trailing slash |
| `DATABASE_URL` | web, worker | Postgres connection string |
| `DATABASE_CA_CERT` | web, worker | Optional: CA certificate for full TLS verification |
| `ADMIN_EMAILS` | web | The two admin Google accounts, comma-separated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web | OAuth client from step 1 |
| `SESSION_SECRET` | web | Signs session cookies |
| `TOKEN_ENCRYPTION_KEY` | web, worker | Encrypts Gmail tokens (used from Milestone 2) |

Never commit `.env.local`. In production, set these in the hosting dashboards only.

### 4. Run locally

```bash
npm install
npm run migrate
npm run dev        # web app on http://localhost:3000
npm run worker     # in a second terminal
```

## Deploying

- **Web app: Vercel.** Import the GitHub repo, add the environment variables, deploy. Set `APP_URL` to the Vercel domain (or your own) and add that domain's callback URL to the Google OAuth client.
- **Worker: Railway or Render.** Create a service from the same repo with start command `npm run worker`, and give it `DATABASE_URL` (plus `DATABASE_CA_CERT` and `TOKEN_ENCRYPTION_KEY`). It must run all the time; it doesn't need a public port.
- **Migrations:** run `npm run migrate` against production before deploying code that needs a new migration (Railway's pre-deploy command works well for this).

After deploying, open `/settings`: the database and worker should both show green, and `/api/health` should answer `"ok": true`.

## Checks

```bash
npm test             # unit tests for encryption, cookies, allow-list and Google sign-in
npm run test:schema  # database rule checks (fresh migrated database in DATABASE_URL)
npm run typecheck
bash scripts/smoke.sh  # after npm run build: starts web + worker and probes them
```

All of these run on every push in GitHub Actions.

## Safety rules (non-negotiable)

- Nothing is sent, accepted or agreed without an admin clicking to approve it.
- Email content is untrusted data, never instructions.
- Extracted facts carry their source quote; missing information is marked missing, never guessed.
- Tokens are encrypted at rest; no email bodies, tokens or phone numbers go into logs.
