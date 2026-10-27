"use client";

// The top bar: the wordmark and a short row of places. (Named Sidebar for history; it's a top bar now.)
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Stage" },
  { href: "/map", label: "Map" },
  { href: "/opportunities", label: "Offers" },
  { href: "/review", label: "To check" },
  { href: "/alerts", label: "Alerts" },
  { href: "/mail", label: "Mail" },
  { href: "/settings", label: "Settings" },
] as const;

export function Sidebar({ email, name, unreadAlerts }: { email: string; name: string | null; unreadAlerts: number }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const initial = (name ?? email).trim().charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-20 border-b border-line/60 bg-paper/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 md:px-10">
        <Link href="/" className="flex items-center gap-2.5 font-display text-xl font-bold tracking-tight">
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24">
            <circle cx="12" cy="4" r="2.6" className="fill-gel" />
            <path d="M9 6.5 L15 6.5 L20 19 L4 19 Z" className="fill-gel" opacity="0.25" />
            <ellipse cx="12" cy="19.5" rx="8" ry="2.2" className="fill-gel" />
          </svg>
          Spotlight
        </Link>

        <nav aria-label="Main" className="order-3 -mx-1 w-full overflow-x-auto md:order-none md:w-auto md:flex-1">
          <ul className="flex gap-1 px-1">
            {NAV.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[15px] transition-colors ${
                      active ? "bg-raised text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {item.label}
                    {item.href === "/alerts" && unreadAlerts > 0 && !active && (
                      <span className="rounded-full bg-gel px-2 py-0.5 text-xs font-semibold tabular-nums text-stage">
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

        <Link
          href="/settings"
          aria-label={`Signed in as ${name ?? email}. Settings`}
          title={email}
          className="ml-auto flex h-10 w-10 items-center justify-center rounded-full border border-line font-display font-semibold md:ml-0"
        >
          {initial}
        </Link>
      </div>
    </header>
  );
}
