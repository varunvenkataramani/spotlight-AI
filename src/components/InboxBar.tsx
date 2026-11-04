import Link from "next/link";
import type { InboxHealth } from "@/lib/gmail/health.ts";

const WHEN = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** A bar on every page while the inbox isn't being read, or is about to stop. Hidden when all is well. */
export function InboxBar({ email, canReply, health }: { email: string; canReply: boolean; health: InboxHealth }) {
  if (health.state === "ok") return null;
  const reconnect = `/api/gmail/connect?hint=${encodeURIComponent(email)}${canReply ? "&send=1" : ""}`;
  const urgent = health.state === "needs_reconnect";
  const text =
    health.state === "needs_reconnect"
      ? `Gmail stopped working${health.since ? ` on ${WHEN.format(health.since)}` : ""}, so new offers aren't coming in. Reconnect to catch up: missed emails are read automatically.`
      : health.state === "stalled"
        ? `Spotlight hasn't been able to read Gmail since ${WHEN.format(health.since)}. Reconnecting usually fixes it; Settings shows the reason.`
        : `Google ends Spotlight's Gmail access on ${WHEN.format(health.endsAt)}, its weekly limit while the Google app is in testing. Reconnect now so nothing is missed.`;
  return (
    <div role={urgent ? "alert" : "status"} className={`border-b px-5 py-3 text-sm md:px-10 ${urgent ? "border-alert/50 bg-alert/15" : "border-gel/40 bg-gel-soft"}`}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <span className={`font-semibold ${urgent ? "text-alert" : "text-gel"}`}>{urgent ? "Gmail disconnected" : health.state === "stalled" ? "Gmail not syncing" : "Reconnect Gmail today"}</span>
        <span className="min-w-0 flex-1 text-ink-soft">{text}</span>
        <span className="flex gap-3">
          <a href={reconnect} className={`inline-flex min-h-9 items-center rounded-full px-4 font-semibold ${urgent ? "bg-alert text-stage" : "bg-gel text-stage"}`}>
            Reconnect Gmail
          </a>
          {health.state === "stalled" && (
            <Link href="/settings#gmail" className="inline-flex min-h-9 items-center font-medium underline underline-offset-4">
              See why
            </Link>
          )}
        </span>
      </div>
    </div>
  );
}
