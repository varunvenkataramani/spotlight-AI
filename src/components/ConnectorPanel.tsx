// Settings: how to add Spotlight to the Claude app, and the connections that exist.
import { formatIST } from "@/components/ui";
import type { Connection } from "@/server/oauth.ts";

export function ConnectorPanel({ url, connections }: { url: string; connections: Connection[] }) {
  return (
    <section id="claude" className="scroll-mt-8 rounded-2xl border border-line bg-surface p-6">
      <h2 className="font-display text-xl font-semibold">Claude app</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Ask about offers from Claude on your phone or computer: “what's due this week?”, “what did Glow Labs offer?”, “remind me Friday to follow up”. Claude
        can read and make small changes when you ask; it can't send email or accept or decline anything.
      </p>

      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        <li>
          On a computer, open <b>claude.ai</b> → <b>Settings → Connectors</b> → <b>Add custom connector</b>.
        </li>
        <li>
          Name it <b>Spotlight</b> and paste this address:
          <code className="mt-1 block select-all break-all rounded-lg bg-paper px-3 py-2 font-mono text-xs">{url}</code>
        </li>
        <li>
          Press <b>Connect</b>, sign in to Spotlight if asked, and choose <b>Allow</b>.
        </li>
        <li>It then works in the Claude app on your phone too. Each admin connects with their own Claude account.</li>
      </ol>

      <h3 className="mt-6 text-sm font-semibold">Connected</h3>
      {connections.length === 0 ? (
        <p className="mt-1 text-sm text-muted">Nothing yet. After you choose Allow, the connection is listed here.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line text-sm">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{c.client_name}</span>
                <span className="text-muted">{` · connected ${formatIST(c.created_at)}${c.last_used_at ? ` · last used ${formatIST(c.last_used_at)}` : ""}`}</span>
              </span>
              <form method="post" action="/api/settings">
                <input type="hidden" name="action" value="claude_disconnect" />
                <input type="hidden" name="grant" value={c.id} />
                <button className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium hover:border-ink/30">Disconnect</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
