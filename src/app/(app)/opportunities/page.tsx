import type { Metadata } from "next";
import Link from "next/link";
import { OpportunityCard } from "@/components/OpportunityCard";
import { Flash } from "@/components/detail";
import { EmptyState, PageHeader } from "@/components/ui";
import { DEFAULT_FILTERS, filtersToQuery, parseFilters, STAGES, type ListFilters } from "@/lib/edits.ts";
import { formatDay, payText } from "@/lib/format.ts";
import { getInboxStatus } from "@/server/gmail.ts";
import { getAiOverview, listCategories, listOpportunities, type OpportunityCard as Card } from "@/server/opportunities.ts";

export const metadata: Metadata = { title: "Opportunities" };

const SHOW: Array<[ListFilters["show"], string]> = [
  ["active", "Open"],
  ["waiting", "Waiting on them"],
  ["closed", "Closed"],
  ["all", "Everything"],
];
const PRIORITIES: Array<[string, string]> = [
  ["", "Any priority"],
  ["high", "High"],
  ["needs_review", "Check this"],
  ["medium", "Medium"],
  ["low", "Low"],
];
const SORTS: Array<[ListFilters["sort"], string]> = [
  ["urgent", "Most urgent"],
  ["newest", "Newest"],
  ["pay", "Highest pay"],
];
const SELECT = "rounded-lg border border-line bg-surface px-3 py-2 text-sm";

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const [opportunities, ai, inbox, categories] = await Promise.all([
    listOpportunities({ filters: filters.view === "board" ? { ...filters, show: filters.show === "active" ? "all" : filters.show } : filters }),
    getAiOverview(),
    getInboxStatus(),
    listCategories(),
  ]);
  const filtered = filters.q !== "" || filters.category !== null || filters.priority !== null || filters.show !== DEFAULT_FILTERS.show;
  const one = (k: string) => (Array.isArray(params[k]) ? params[k]![0] : params[k]);

  return (
    <>
      <PageHeader
        title="Opportunities"
        lead={opportunities.length > 0 ? "One card per project, however many emails it took." : undefined}
      />
      <Flash done={one("done")} error={one("error")} />

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3" role="search">
        <input type="hidden" name="view" value={filters.view} />
        <label className="grid min-w-[12rem] flex-1 gap-1 text-xs text-muted">
          Search
          <input name="q" defaultValue={filters.q} placeholder="Brand, person or keyword" className={`${SELECT} w-full`} />
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Show
          <select name="show" defaultValue={filters.show} className={SELECT}>
            {SHOW.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Category
          <select name="category" defaultValue={filters.category ?? ""} className={SELECT}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Priority
          <select name="priority" defaultValue={filters.priority ?? ""} className={SELECT}>
            {PRIORITIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-muted">
          Sort
          <select name="sort" defaultValue={filters.sort} className={SELECT}>
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-paper hover:bg-ink-soft">Apply</button>
        {filtered && (
          <Link href={filtersToQuery(DEFAULT_FILTERS, { view: filters.view }) || "/opportunities"} className="py-2 text-sm text-muted underline-offset-4 hover:underline">
            Clear
          </Link>
        )}
      </form>

      <nav aria-label="View" className="mb-6 flex gap-1 text-sm">
        {(["list", "board"] as const).map((v) => (
          <Link
            key={v}
            href={`/opportunities${filtersToQuery(filters, { view: v })}`}
            aria-current={filters.view === v ? "page" : undefined}
            className={`rounded-full px-4 py-1.5 ${filters.view === v ? "bg-ink text-paper" : "border border-line hover:border-ink/30"}`}
          >
            {v === "list" ? "List" : "Board"}
          </Link>
        ))}
      </nav>

      {ai.waiting > 0 && ai.keyConfigured && (
        <p role="status" className="mb-6 text-sm text-muted">
          {ai.waiting} {ai.waiting === 1 ? "email is" : "emails are"} still being sorted. New offers appear when you reload.
        </p>
      )}

      {opportunities.length === 0 ? (
        filtered ? (
          <EmptyState title="Nothing matches">Try a different search or clear the filters.</EmptyState>
        ) : !inbox ? (
          <EmptyState title="No inbox connected">
            Connect Gmail in{" "}
            <Link className="underline decoration-gel decoration-2 underline-offset-4" href="/settings#gmail">
              Settings
            </Link>
            . Offers found in the inbox appear here as cards.
          </EmptyState>
        ) : !ai.keyConfigured ? (
          <EmptyState title="AI sorting is off">
            Spotlight has read {inbox.storedTotal} emails but can't sort them yet. Add ANTHROPIC_API_KEY in Vercel and redeploy;
            sorting starts within a minute. Meanwhile, you can turn any email into a card from Needs review.
          </EmptyState>
        ) : (
          <EmptyState title="No offers found yet">
            {ai.waiting > 0
              ? `Spotlight is sorting ${ai.waiting} emails. Offers appear here as they're found.`
              : "Nothing in the inbox looks like an offer so far. Emails the AI wasn't sure about are in Needs review."}
          </EmptyState>
        )
      ) : filters.view === "board" ? (
        <Board cards={opportunities} />
      ) : (
        <div className="space-y-4">
          {opportunities.map((o) => (
            <OpportunityCard key={o.id} o={o} />
          ))}
        </div>
      )}
    </>
  );
}

const DOT: Record<Card["priority"], string> = {
  high: "bg-gel",
  needs_review: "bg-alert",
  medium: "bg-ink/40",
  low: "bg-line",
};

function Board({ cards }: { cards: Card[] }) {
  const columns = STAGES.map((stage) => ({
    ...stage,
    cards: cards.filter((c) => (stage.statuses as readonly string[]).includes(c.status)),
  })).filter((col) => col.key !== "done" || col.cards.length > 0);

  return (
    <div className="-mx-5 overflow-x-auto px-5 pb-4 md:-mx-12 md:px-12">
      <div className="grid min-w-max auto-cols-[16rem] grid-flow-col gap-4">
        {columns.map((col) => (
          <section key={col.key} aria-label={col.label} className="min-w-0">
            <h2 className="mb-3 flex items-baseline justify-between text-sm font-semibold">
              {col.label}
              <span className="font-normal tabular-nums text-muted">{col.cards.length}</span>
            </h2>
            <ul className="space-y-2">
              {col.cards.length === 0 && <li className="rounded-xl border border-dashed border-line px-3 py-4 text-xs text-muted">Nothing here</li>}
              {col.cards.map((c) => (
                <li key={c.id}>
                  <Link href={`/opportunities/${c.id}`} className="block rounded-xl border border-line bg-surface p-3 hover:border-ink/30">
                    <span className="flex items-start gap-2">
                      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[c.priority]}`} />
                      <span className="min-w-0 text-sm font-medium leading-snug">{c.title}</span>
                    </span>
                    <span className="mt-1 block truncate pl-4 text-xs text-muted">{c.organization ?? c.sender_name ?? c.sender_email}</span>
                    <span className="mt-1 flex justify-between gap-2 pl-4 text-xs tabular-nums">
                      <span>{payText(c)}</span>
                      {c.next_deadline_at && <span className="text-muted">{formatDay(c.next_deadline_at)}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
