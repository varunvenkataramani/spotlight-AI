"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/opportunities", label: "Opportunities" },
  { href: "/review", label: "Needs review" },
  { href: "/alerts", label: "Alerts" },
  { href: "/mail", label: "Synced mail" },
  { href: "/settings", label: "Settings" },
] as const;

export function Sidebar({ email, name, unreadAlerts }: { email: string; name: string | null; unreadAlerts: number }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <aside className="flex shrink-0 flex-col bg-ink text-paper md:sticky md:top-0 md:h-dvh md:w-60">
      <div className="flex items-center justify-between px-5 py-4 md:block md:px-6 md:py-7">
        <Link href="/" className="font-display text-2xl font-semibold tracking-tight">
          Spotlight
        </Link>
      </div>

      <nav aria-label="Main" className="overflow-x-auto px-3 pb-3 md:flex-1 md:px-3 md:pb-0">
        <ul className="flex gap-1 md:flex-col">
          {NAV.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-[15px] transition-colors ${
                    active ? "bg-ink-soft text-paper" : "text-paper/65 hover:bg-ink-soft/60 hover:text-paper"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${active ? "bg-gel" : "bg-transparent"}`}
                  />
                  {item.label}
                  {item.href === "/alerts" && unreadAlerts > 0 && !active && (
                    <span className="ml-auto rounded-full bg-gel px-2 py-0.5 text-xs font-semibold tabular-nums text-ink">
                      {unreadAlerts > 99 ? "99+" : unreadAlerts}
                      <span className="sr-only"> unread</span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="hidden border-t border-ink-line px-6 py-5 md:block">
        <p className="truncate text-sm font-medium">{name ?? email}</p>
        {name && <p className="truncate text-xs text-paper/55">{email}</p>}
        <form action="/api/auth/logout" method="post" className="mt-3">
          <button type="submit" className="text-sm text-paper/65 underline-offset-4 hover:text-paper hover:underline">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
