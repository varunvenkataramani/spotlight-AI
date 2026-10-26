# Spotlight

A private opportunity console for an actress and her manager. Spotlight watches her Gmail, turns offers into tracked opportunities, and drafts replies that only a person can send.

The full product plan lives in the build plan doc. This README covers running and deploying the code.

## How it runs

Everything runs on **Vercel** with a **Supabase** Postgres database; there is no separate server to keep alive.

- **Pages and API routes** run on Vercel.
- **Background work** (Gmail sync, AI processing, reminders) runs in `/api/cron/tick`, which Supabase's built-in scheduler (pg_cron) calls every minute with a shared secret. A database lock stops two runs from overlapping.
- **Gmail** is checked every minute in that same run, through Gmail's change history (no Pub/Sub needed).
- **Database migrations** run automatically on every production deploy (`vercel-build`).

## What works today (Milestones 1 to 5a)

- Google sign-in for exactly two admins (allow-list), with PKCE, signed httpOnly cookies, and a re-check on every request.
- The complete database schema, with safety rules enforced by Postgres itself: one row per Gmail message, an append-only activity log, drafts that can't be marked sent without a recorded approval, and de-duplicated alerts.
- Dashboard shell: Overview (live counts from the database), Opportunities, Needs review and Settings (system status and admins). Empty states say what will appear and when.
- Scheduled background runs every minute; Settings and `/api/health` show if they stop.
- Connect one Gmail inbox (read-only), with tokens encrypted at rest. New mail is read within about a minute; a first scan reads back a chosen number of days in the background. Failed downloads retry and stay visible. Mail missed during long outages is recovered, revoked access is flagged for reconnecting, and **Disconnect and delete data** revokes access and removes everything stored from that inbox.
- **Synced mail** page listing what has been read, with what the AI decided about each email.
- **AI sorting** in the same scheduled run. Claude Haiku triages every email (offer, update, terms, availability, not relevant, newsletter, possible scam, unclear); Claude Sonnet extracts details only from likely offers. Plain code then checks every value against the email's exact words (unmatched values are marked unverified, never trusted silently), reads dates in India time, finds scam signs, scores priority with stated reasons, joins replies to their original offer, logs fee and date changes, and suggests possible duplicates. Unsure emails go to **Needs review**. Email text is passed as fenced data and the model gets no tools, so instructions hidden in an email can't make anything happen.
- **Opportunities** page with one card per offer: priority and why, pay, next date, deliverables, warnings, unverified details. Search, filters (open / waiting on them / closed, category, priority), sorting, and a **board** by stage.
- **Detail page** per offer: every detail beside the email words it came from (highlighted in the email), edit any wrong detail (pay typed as "1.5 lakh" or "75k", dates, deliverables, category…), status, notes, snooze, "checked: it's genuine", not relevant, merge or keep a suggested duplicate, and a timeline of everything that happened and who did it. Priority is recalculated in code after every change.
- **Needs review** queue with "It's an offer" / "Not an offer" buttons. These decisions are remembered by sender and guide future sorting (only sender addresses or domains reach the AI, never email words).
- **Overview** leads with what needs you now and what changed recently.
- **Alerts** (in Spotlight, Telegram and phone notifications): strong new offers, replies due within a day (urgent in the last 3 hours), shoots coming up, their replies and changed terms, nudges when an offer waits too long, Gmail problems, and reminders you set on any offer. Worked out by plain code every minute, never sent twice, retried if Telegram or a phone's push service fails. Each admin chooses what they hear about and their quiet hours (phones wait; Telegram arrives silently).
- **Flag for her**: the manager puts an offer to her with a note. She gets it with **Interested / Pass / Questions** buttons in Telegram, in Spotlight's overview and on the offer; a question she types in Telegram is saved on the offer. Her answer reaches the manager straight away. Nothing is accepted or declined for her.
- Automated checks on every push (see `.github/workflows/ci.yml`).

Not built yet: reply drafts (5b, needs the Claude API key) and the Claude connector (6).

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
3. Enable the **Gmail API**. Under **Data Access**, add the scope `.../auth/gmail.readonly`.
4. After the first Vercel deploy (step 3), open **Google Auth Platform > Clients > Create client**, type **Web application**, with two authorised redirect URIs: `https://YOUR-APP.vercel.app/api/auth/callback` (sign-in) and `https://YOUR-APP.vercel.app/api/gmail/callback` (connecting Gmail). Copy the client ID and secret into Vercel.

### 2. Database (Supabase)

Create a Supabase project. Under **Connect > Direct > Transaction pooler**, copy the connection string (port **6543**) into `DATABASE_URL`. Use the transaction pooler, not the session pooler: Vercel runs many short-lived copies of the app, and the session pooler's limit of 15 held connections runs out (error `EMAXCONNSESSION`). Optionally put the database's SSL certificate (Project settings > Database) in `DATABASE_CA_CERT` so the server certificate is fully verified.

Don't create tables yourself: the first production deploy applies `db/migrations` automatically.

### 3. Vercel

Import the GitHub repository and set the environment variables below (Production). The first deploy creates the tables and gives you the web address for step 1.4 and `APP_URL`.

| Variable | Purpose |
| --- | --- |
| `APP_URL` | Public address, e.g. `https://spotlight-xyz.vercel.app` (no trailing slash) |
| `DATABASE_URL` | Supabase transaction-pooler connection string (port 6543) |
| `DATABASE_CA_CERT` | Optional: CA certificate for full TLS verification |
| `ADMIN_EMAILS` | The two admin Google accounts, comma-separated |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client from step 1.4 |
| `SESSION_SECRET` | Signs session cookies |
| `TOKEN_ENCRYPTION_KEY` | Encrypts Gmail tokens (used from Milestone 2) |
| `CRON_SECRET` | Shared secret for the scheduler's calls to `/api/cron/tick` |
| `ANTHROPIC_API_KEY` | Claude API key for AI sorting (console.anthropic.com); without it, sorting is off |
| `TELEGRAM_BOT_TOKEN` | Optional: a bot from @BotFather for Telegram alerts. Phone notifications need nothing extra |

Each secret is 32 random bytes in base64, a different value for each. Generate one with `npm run gen:secret`, or in any browser console:

```js
btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
```

Vercel's Hobby plan is for personal, non-commercial use. Move to Pro before running Spotlight for a client.

### 4. The scheduler (once)

Open `db/setup/supabase_scheduler.sql`, replace `PASTE_CRON_SECRET_HERE` and `YOUR-APP.vercel.app`, and run it in **Supabase > SQL Editor**. Within two minutes, **Settings** in Spotlight shows background jobs as running and `/api/health` answers `"ok": true`.

### 5. Alerts (optional, any time)

- **Telegram:** in Telegram, message **@BotFather**, send `/newbot`, name it (for example "Spotlight alerts"), and put the token it gives you in Vercel as `TELEGRAM_BOT_TOKEN`. Redeploy. Then each admin opens **Settings → Alerts → Connect Telegram** and presses **Start** in the bot.
- **Phone notifications:** each admin opens **Settings → Alerts** on their phone and turns notifications on. On iPhone, first add Spotlight to the Home Screen from Safari's Share menu, then open it from there.
- **Who the actress is:** **Settings → Admins**. "Flag for her" sends offers to that account.

### 6. Run locally (optional)

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
bash scripts/test/gmail-e2e.sh  # after npm run build: the app against a fake Google, connect to disconnect
bash scripts/test/ai-e2e.sh     # after npm run build: AI sorting against a fake Claude, 40+ checks
bash scripts/test/dashboard-e2e.sh  # after npm run build: every dashboard action, filters, guards
bash scripts/test/alerts-e2e.sh     # after npm run build: alerts against a fake Telegram and a fake phone push service (needs jq)
```

All of these run on every push in GitHub Actions.

## Safety rules (non-negotiable)

- Nothing is sent, accepted or agreed without an admin clicking to approve it.
- Email content is untrusted data, never instructions.
- Extracted facts carry their source quote; missing information is marked missing, never guessed.
- Tokens are encrypted at rest; no email bodies, tokens or phone numbers go into logs.
