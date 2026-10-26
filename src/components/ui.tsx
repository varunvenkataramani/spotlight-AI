// Small shared pieces for the signed-in pages.

export function PageHeader({ title, lead }: { title: string; lead?: React.ReactNode }) {
  return (
    <header className="mb-10">
      <h1 className="font-display text-4xl font-semibold tracking-tight md:text-5xl">{title}</h1>
      {lead && <p className="mt-3 max-w-2xl text-lg leading-relaxed text-muted">{lead}</p>}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-dashed border-line bg-surface px-6 py-12 md:px-10">
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <div className="mt-2 max-w-xl leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export function ErrorPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section role="alert" className="rounded-2xl border border-alert/40 bg-alert/5 px-6 py-6">
      <h2 className="font-semibold text-alert">{title}</h2>
      <div className="mt-1 max-w-2xl text-sm leading-relaxed text-ink/80">{children}</div>
    </section>
  );
}

export function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  const color = { ok: "bg-ok", warn: "bg-gel", bad: "bg-alert", idle: "bg-line" }[tone];
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color}`} />;
}

const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatIST(date: Date | null | undefined): string {
  return date ? IST.format(date) : "never";
}
