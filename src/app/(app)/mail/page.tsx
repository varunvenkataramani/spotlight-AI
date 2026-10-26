import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader, formatIST } from "@/components/ui";
import { getInboxStatus, listSyncedEmails } from "@/server/gmail.ts";

export const metadata: Metadata = { title: "Synced mail" };

const LIMIT = 50;

export default async function SyncedMailPage() {
  const [inbox, emails] = await Promise.all([getInboxStatus(), listSyncedEmails(LIMIT)]);

  return (
    <>
      <PageHeader
        title="Synced mail"
        lead="Every email Spotlight has read from the inbox, newest first. Sorting them into opportunities comes in the next update."
      />

      {!inbox ? (
        <EmptyState title="No inbox connected">
          Connect Gmail in <Link className="underline decoration-gel decoration-2 underline-offset-4" href="/settings#gmail">Settings</Link>,
          and emails appear here within a minute or two.
        </EmptyState>
      ) : emails.length === 0 ? (
        <EmptyState title="Reading the inbox">
          Spotlight is connected to {inbox.email} and checks it every minute. The first emails appear here shortly; this page
          shows the latest when you reload it.
        </EmptyState>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            Showing the latest {emails.length} of {inbox.storedTotal} from {inbox.email}.
          </p>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {emails.map((e) => (
              <li key={e.id} className="grid gap-1 px-5 py-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:gap-5">
                <div className="min-w-0">
                  <p className="truncate font-medium">{e.from_name ?? e.from_email ?? "Unknown sender"}</p>
                  {e.from_name && <p className="truncate text-xs text-muted">{e.from_email}</p>}
                </div>
                <div className="min-w-0">
                  <p className="truncate">{e.subject || "(no subject)"}</p>
                  {e.snippet && <p className="truncate text-sm text-muted">{e.snippet}</p>}
                </div>
                <div className="flex items-center gap-2 text-sm text-muted sm:flex-col sm:items-end sm:gap-1">
                  <time dateTime={e.received_at.toISOString()} className="tabular-nums whitespace-nowrap">
                    {formatIST(e.received_at)}
                  </time>
                  <span className="flex gap-1.5">
                    {e.has_attachments && <span className="rounded-full border border-line px-2 py-0.5 text-xs">Attachment</span>}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        e.is_historical ? "border border-line" : "bg-gel-soft text-ink"
                      }`}
                    >
                      {e.is_historical ? "Earlier mail" : "New"}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
