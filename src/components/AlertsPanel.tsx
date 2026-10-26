// Settings: where alerts go (Spotlight, Telegram, this phone), what to hear about, and quiet hours.
import { PushToggle } from "@/components/PushToggle";
import { StatusDot, formatIST } from "@/components/ui";
import type { AlertSettings } from "@/server/alerts.ts";

const BUTTON = "rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft";
const BUTTON_QUIET = "rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-ink/30";

const STATUS_TEXT: Record<string, string> = { sent: "Delivered", pending: "Waiting", failed: "Failed", suppressed: "Not sent" };

function SettingsForm({ action, children, className }: { action: string; children: React.ReactNode; className?: string }) {
  return (
    <form method="post" action="/api/settings" className={className}>
      <input type="hidden" name="action" value={action} />
      {children}
    </form>
  );
}

export function AlertsPanel({ s, isTalent }: { s: AlertSettings; isTalent: boolean }) {
  return (
    <section id="alerts" className="scroll-mt-8 rounded-2xl border border-line bg-surface p-6">
      <h2 className="font-display text-xl font-semibold">Alerts</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Spotlight tells you about strong new offers, replies due soon, changed terms and offers waiting on you.
        {isTalent ? " Offers your manager puts to you arrive with Interested, Pass and Questions buttons." : ""} These settings are just for you.
      </p>

      <h3 className="mt-6 text-sm font-semibold">Where they go</h3>
      <ul className="mt-2 divide-y divide-line text-sm">
        <li className="flex items-start gap-3 py-3">
          <span className="mt-1.5"><StatusDot tone="ok" /></span>
          <div>
            <p className="font-medium">Spotlight</p>
            <p className="text-muted">Every alert is listed on the Alerts page.</p>
          </div>
        </li>

        <li className="flex items-start gap-3 py-3">
          <span className="mt-1.5"><StatusDot tone={s.telegramLinked ? "ok" : "idle"} /></span>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-medium">Telegram</p>
            {!s.telegramConfigured ? (
              <div className="space-y-1 leading-relaxed text-muted">
                <p>Not set up yet. One-time setup (about 5 minutes):</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, and give it a name like “Spotlight alerts”.</li>
                  <li>Copy the token it gives you into Vercel → Settings → Environment Variables as <code>TELEGRAM_BOT_TOKEN</code> (Production).</li>
                  <li>Redeploy, then come back here and press “Connect Telegram”.</li>
                </ol>
              </div>
            ) : s.telegramLinked ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-ok">{s.telegramBot ? `Connected to @${s.telegramBot}.` : "Connected."}</span>
                <SettingsForm action="telegram_disconnect">
                  <button className={BUTTON_QUIET}>Disconnect</button>
                </SettingsForm>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-muted">Opens the Spotlight bot in Telegram. Press <b>Start</b> there and this account is linked.</p>
                <SettingsForm action="telegram_connect">
                  <button className={BUTTON}>Connect Telegram</button>
                </SettingsForm>
              </div>
            )}
          </div>
        </li>

        <li className="flex items-start gap-3 py-3">
          <span className="mt-1.5"><StatusDot tone={s.phones > 0 ? "ok" : "idle"} /></span>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="font-medium">Phone and browser notifications</p>
            <p className="text-muted">
              {s.phones === 0 ? "Not on for any device yet." : `On for ${s.phones} ${s.phones === 1 ? "device" : "devices"}.`} Turn them on separately on each phone or computer.
            </p>
            <PushToggle publicKey={s.pushKey} />
          </div>
        </li>
      </ul>

      <SettingsForm action="alerts" className="mt-6 space-y-5 border-t border-line pt-6 text-sm">
        <fieldset className="space-y-2">
          <legend className="font-semibold">What to hear about</legend>
          <label className="flex flex-wrap items-center gap-2">
            New offers:
            <select name="new_offers" defaultValue={s.types.newOffers} className="rounded-lg border border-line bg-surface px-3 py-2">
              <option value="high">High priority only</option>
              <option value="all">Every new offer</option>
              <option value="off">None</option>
            </select>
          </label>
          <Check name="deadlines" on={s.types.deadlines} label="Replies due and shoots or events coming up within a day" />
          <Check name="changes" on={s.types.changes} label="Their replies, changed fees or dates, and cancellations" />
          <Check name="nudges" on={s.types.nudges} label="Nudges when an offer has waited a few days" />
          <p className="text-xs text-muted">Offers put to her, her answers, reminders you set and Gmail problems always come through.</p>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="font-semibold">Send them to</legend>
          <Check name="telegram" on={s.channels.telegram} label="Telegram (once connected)" />
          <Check name="push" on={s.channels.push} label="Phones and browsers where notifications are on" />
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="font-semibold">Quiet hours (India time)</legend>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              From <input type="time" name="quiet_start" defaultValue={s.quietStart} className="rounded-lg border border-line bg-surface px-3 py-2" required />
            </label>
            <label className="flex items-center gap-2">
              to <input type="time" name="quiet_end" defaultValue={s.quietEnd} className="rounded-lg border border-line bg-surface px-3 py-2" required />
            </label>
          </div>
          <p className="text-xs text-muted">
            Phone notifications wait until quiet hours end; Telegram messages still arrive, without a sound. A reply due within 3 hours and your own reminders ring anyway. Set both times the same to turn quiet hours off.
          </p>
        </fieldset>

        <button className={BUTTON}>Save alert settings</button>
      </SettingsForm>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <SettingsForm action="test">
          <button className={BUTTON_QUIET}>Send me a test alert</button>
        </SettingsForm>
        <span className="text-sm text-muted">Goes to every place above that's on for you.</span>
      </div>

      {s.recent.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold">Recent deliveries</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {s.recent.map((r, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{r.channel === "push" ? "Phone" : "Telegram"}</span> · {r.title}
                  {r.error && r.status !== "sent" && <span className="block text-xs text-muted">{r.error}</span>}
                </span>
                <span className={`text-xs ${r.status === "failed" ? "text-alert" : "text-muted"}`}>
                  {STATUS_TEXT[r.status] ?? r.status} · {formatIST(r.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Check({ name, on, label }: { name: string; on: boolean; label: string }) {
  return (
    <label className="flex items-start gap-2">
      <input type="checkbox" name={name} defaultChecked={on} className="mt-1 h-4 w-4 accent-ink" />
      <span>{label}</span>
    </label>
  );
}
