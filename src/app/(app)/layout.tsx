import { Sidebar } from "@/components/Sidebar";
import { DEMO_TALENT_EMAIL, isDemoMode } from "@/lib/config.ts";
import { unreadAlertCount } from "@/server/alerts.ts";
import { requireAdmin } from "@/server/session.ts";

// Every page in this group is private and always rendered fresh.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  // The badge is a nicety: if the database is down, pages still explain that themselves.
  const unread = await unreadAlertCount(admin.userId).catch(() => 0);
  return (
    <div className="flex min-h-dvh flex-col">
      {isDemoMode() && <DemoBar isTalent={admin.email === DEMO_TALENT_EMAIL} />}
      <Sidebar email={admin.email} name={admin.name} unreadAlerts={unread} />
      <main className="flex-1 px-5 pb-16 pt-8 md:px-10 md:pt-10">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

/** Says plainly that this is the demo, and lets visitors switch view or start over. */
function DemoBar({ isTalent }: { isTalent: boolean }) {
  return (
    <div className="border-b border-gel/30 bg-gel-soft px-5 py-2 text-sm md:px-10">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-gel">Demo</span>
        <span className="text-ink-soft">{`Made-up offers. You're seeing ${isTalent ? "Tara's (the actress's)" : "Kabir's (her manager's)"} view. Nothing is sent.`}</span>
        <span className="ml-auto flex gap-4">
          <form method="post" action="/api/demo/enter">
            <button name="as" value={isTalent ? "manager" : "talent"} className="font-medium underline underline-offset-4 hover:text-gel">
              {isTalent ? "Switch to Kabir" : "Switch to Tara"}
            </button>
          </form>
          <form method="post" action="/api/demo/enter">
            <input type="hidden" name="as" value={isTalent ? "talent" : "manager"} />
            <button name="reset" value="1" className="font-medium underline underline-offset-4 hover:text-gel">
              Start over
            </button>
          </form>
        </span>
      </div>
    </div>
  );
}
