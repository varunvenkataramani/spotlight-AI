import { Sidebar } from "@/components/Sidebar";
import { unreadAlertCount } from "@/server/alerts.ts";
import { requireAdmin } from "@/server/session.ts";

// Every page in this group is private and always rendered fresh.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  // The badge is a nicety: if the database is down, pages still explain that themselves.
  const unread = await unreadAlertCount(admin.userId).catch(() => 0);
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar email={admin.email} name={admin.name} unreadAlerts={unread} />
      <main className="flex-1 px-5 py-8 md:px-12 md:py-12">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
