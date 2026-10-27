import { SCAN_DAY_CHOICES, DEFAULT_SCAN_DAYS, type InboxStatus } from "@/server/gmail.ts";
import { StatusDot, formatIST } from "@/components/ui";

const OUTCOMES: Record<string, { tone: "ok" | "bad"; text: string }> = {
  connected: { tone: "ok", text: "Gmail connected. The first scan has started, and new mail shows up here within a minute or two." },
  reconnected: { tone: "ok", text: "Gmail reconnected. Sync carries on from where it stopped." },
  disconnected: {
    tone: "ok",
    text: "Gmail disconnected. Spotlight's access was removed, and every email and opportunity from that inbox was deleted.",
  },
  access_denied: { tone: "bad", text: "Connecting was cancelled on Google's screen. Nothing changed." },
  scope_not_granted: {
    tone: "bad",
    text: "Spotlight needs permission to read email. Connect again and leave “View your email messages and settings” ticked.",
  },
  no_refresh_token: {
    tone: "bad",
    text: "Google didn't grant lasting access. Remove Spotlight at myaccount.google.com/permissions, then connect again.",
  },
  state_mismatch: { tone: "bad", text: "The connection link expired or was opened in another browser. Start again from this page." },
  other_inbox_connected: { tone: "bad", text: "Another inbox is already connected. Disconnect it first, then connect the new one." },
  account_mismatch: { tone: "bad", text: "Google returned a different account from the one chosen. Try connecting again." },
  token_exchange_failed: {
    tone: "bad",
    text: "Google didn't complete the connection. Check that /api/gmail/callback is listed in the Google client's redirect URIs, then try again.",
  },
  confirm_needed: { tone: "bad", text: "Tick the confirmation box before disconnecting. Nothing was deleted." },
  config: { tone: "bad", text: "Gmail can't be connected until the Google client settings and TOKEN_ENCRYPTION_KEY are set in Vercel." },
  unknown: { tone: "bad", text: "Connecting failed for an unexpected reason. Try again in a minute." },
};

function scanLabel(days: number) {
  return days === 365 ? "the last year" : `the last ${days} days`;
}

export function InboxPanel({ inbox, outcome }: { inbox: InboxStatus | null; outcome?: string }) {
  const message = outcome ? OUTCOMES[outcome] : undefined;
  return (
    <section id="gmail" className="rounded-2xl border border-line bg-surface p-6">
      <h2 className="font-display text-xl font-semibold">Inbox</h2>

      {message && (
        <p
          role={message.tone === "bad" ? "alert" : "status"}
          className={`mt-4 rounded-lg px-4 py-3 text-sm leading-relaxed ${
            message.tone === "bad" ? "border border-alert/40 bg-alert/5" : "border border-ok/40 bg-ok/5"
          }`}
        >
          {message.text}
        </p>
      )}

      {inbox ? <Connected inbox={inbox} /> : <NotConnected />}
    </section>
  );
}

function NotConnected() {
  return (
    <form action="/api/gmail/connect" method="get" className="mt-4 space-y-4">
      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        Connect the Gmail inbox Spotlight should watch. Google will ask for permission to read email; Spotlight can't send,
        delete or change anything in the inbox unless you later allow replies.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-sm font-medium" htmlFor="scan_days">
          First scan covers
          <select
            id="scan_days"
            name="scan_days"
            defaultValue={DEFAULT_SCAN_DAYS}
            className="rounded-lg border border-line bg-surface px-3 py-2 font-normal"
          >
            {SCAN_DAY_CHOICES.map((d) => (
              <option key={d} value={d}>
                {scanLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-paper hover:bg-ink-soft">
          Connect Gmail
        </button>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Earlier mail is read in the background, a few hundred emails a minute, and never triggers alerts. While the Google app
        is in testing mode, Google asks you to reconnect about once a week.
      </p>
    </form>
  );
}

function Connected({ inbox }: { inbox: InboxStatus }) {
  const needsReconnect = inbox.status !== "connected";
  const scanFinished = inbox.scanListingDone && inbox.waiting === 0;
  const scanText = scanFinished
    ? `First scan finished: ${inbox.storedEarlier} emails from ${scanLabel(inbox.scanDays)}.`
    : inbox.scanListingDone
      ? `First scan: ${inbox.storedEarlier} of ${inbox.scanListed} emails from ${scanLabel(inbox.scanDays)} read.`
      : `First scan: ${inbox.storedEarlier} emails from ${scanLabel(inbox.scanDays)} read so far, still listing.`;

  return (
    <div className="mt-4 space-y-5">
      <dl className="divide-y divide-line text-sm">
        <div className="flex flex-wrap items-start gap-3 py-3">
          <StatusDot tone={needsReconnect ? "bad" : inbox.consecutiveFailures >= 3 ? "warn" : "ok"} />
          <dt className="w-32 shrink-0 font-medium">Account</dt>
          <dd className="min-w-0 break-words">
            {inbox.email}
            <span className="text-muted">{needsReconnect ? " · needs reconnecting" : " · connected"}</span>
          </dd>
        </div>
        <div className="flex flex-wrap items-start gap-3 py-3">
          <span className="w-2.5" />
          <dt className="w-32 shrink-0 font-medium">Last checked</dt>
          <dd className="text-muted">{formatIST(inbox.lastSyncedAt)}</dd>
        </div>
        <div className="flex flex-wrap items-start gap-3 py-3">
          <span className="w-2.5" />
          <dt className="w-32 shrink-0 font-medium">Mail read</dt>
          <dd className="min-w-0 text-muted">
            {inbox.storedNew} new since connecting. {scanText}
            {inbox.waiting > 0 && ` ${inbox.waiting} waiting.`}
          </dd>
        </div>
        <div className="flex flex-wrap items-start gap-3 py-3">
          <StatusDot tone={inbox.canReply ? "ok" : "idle"} />
          <dt className="w-32 shrink-0 font-medium">Replies</dt>
          <dd className="min-w-0 space-y-2 text-muted">
            {inbox.canReply ? (
              <p>Allowed: approved reply drafts can be saved to Gmail or sent from Spotlight. Nothing goes out without an admin confirming.</p>
            ) : (
              <>
                <p>
                  Not allowed yet. To save reply drafts in Gmail or send them from Spotlight, Google must also allow Spotlight to manage drafts and
                  send email. Spotlight only ever sends a reply an admin has read and confirmed.
                </p>
                <a
                  href={`/api/gmail/connect?send=1&hint=${encodeURIComponent(inbox.email)}`}
                  className="inline-block rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft"
                >
                  Allow replies
                </a>
              </>
            )}
          </dd>
        </div>
        {inbox.stuck > 0 && (
          <div className="flex flex-wrap items-start gap-3 py-3">
            <StatusDot tone="warn" />
            <dt className="w-32 shrink-0 font-medium">Couldn't read</dt>
            <dd className="min-w-0 text-muted">
              {inbox.stuck} {inbox.stuck === 1 ? "email" : "emails"} failed after 5 tries. They stay listed here so none are lost
              silently.
            </dd>
          </div>
        )}
        {(needsReconnect || inbox.consecutiveFailures >= 3) && inbox.lastError && (
          <div className="flex flex-wrap items-start gap-3 py-3">
            <StatusDot tone="bad" />
            <dt className="w-32 shrink-0 font-medium">Problem</dt>
            <dd className="min-w-0 text-alert">{inbox.lastError}</dd>
          </div>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={`/api/gmail/connect?hint=${encodeURIComponent(inbox.email)}${inbox.canReply ? "&send=1" : ""}`}
          className={
            needsReconnect
              ? "rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-paper hover:bg-ink-soft"
              : "rounded-full border border-line px-5 py-2 text-sm font-medium hover:border-ink/30"
          }
        >
          Reconnect Gmail
        </a>
      </div>

      <details className="rounded-xl border border-line px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">Disconnect and delete data</summary>
        <form action="/api/gmail/disconnect" method="post" className="mt-3 space-y-3 text-sm">
          <p className="max-w-2xl leading-relaxed text-muted">
            This removes Spotlight's access to {inbox.email} and permanently deletes the {inbox.storedTotal} emails and every
            opportunity Spotlight has stored from it. Nothing in Gmail itself is touched. Use this before connecting a different
            inbox.
          </p>
          <label className="flex items-start gap-2" htmlFor="confirm_delete">
            <input id="confirm_delete" type="checkbox" name="confirm" value="delete" required className="mt-1" />
            <span>I understand this deletes everything Spotlight stored from this inbox.</span>
          </label>
          <button type="submit" className="rounded-full bg-alert px-5 py-2 text-sm font-semibold text-white hover:opacity-90">
            Disconnect and delete data
          </button>
        </form>
      </details>
    </div>
  );
}
