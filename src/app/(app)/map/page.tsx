import type { Metadata } from "next";
import Link from "next/link";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { listMapPoints, type MapPoint } from "@/server/overview.ts";
import { requireAdmin } from "@/server/session.ts";
import { formatDay, payText } from "@/lib/format.ts";

export const metadata: Metadata = { title: "Map" };

const DAY_MS = 86_400_000;
const MAX_DAYS = 60;
const MAX_FEE = 300_000;
// Drawing area inside the SVG (viewBox 1000 x 560).
const L = 70;
const R = 960;
const T = 30;
const B = 440; // bottom of the fee area
const BAND_T = 470; // "No fee yet" band
const BAND_B = 530;

const COLOR: Record<MapPoint["priority"], string> = {
  high: "var(--color-gel)",
  needs_review: "var(--color-alert)",
  medium: "var(--color-ink)",
  low: "var(--color-muted)",
};
const RADIUS: Record<MapPoint["priority"], number> = { high: 11, needs_review: 9, medium: 8, low: 6 };
const LABEL: Record<MapPoint["priority"], string> = { high: "High priority", needs_review: "Check this", medium: "Medium", low: "Low" };

/** Fees on a square-root scale so a ₹20k reel and a ₹2.5L film both have room. */
const feeY = (fee: number) => B - Math.sqrt(Math.min(fee, MAX_FEE) / MAX_FEE) * (B - T);
const dayX = (days: number) => L + (Math.min(Math.max(days, 0), MAX_DAYS) / MAX_DAYS) * (R - L);

type Placed = MapPoint & { x: number; y: number; fee: number | null; days: number | null };

function place(points: MapPoint[]): Placed[] {
  const now = Date.now();
  const bandSlots = new Map<number, number>();
  return points.map((p) => {
    const raw = p.amount_max ?? p.amount_min;
    const fee = raw !== null && p.currency === "INR" && Number(raw) > 0 ? Number(raw) : null;
    const days = p.next_deadline_at ? (p.next_deadline_at.getTime() - now) / DAY_MS : null;
    const x = days === null ? R : dayX(days);
    let y: number;
    if (fee === null) {
      // Spread offers without a fee along the band so they don't sit on top of each other.
      const key = Math.round(x / 40);
      const n = bandSlots.get(key) ?? 0;
      bandSlots.set(key, n + 1);
      y = BAND_T + 16 + (n % 3) * 14;
    } else {
      y = feeY(fee);
    }
    return { ...p, x, y, fee, days };
  });
}

export default async function MapPage() {
  await requireAdmin();
  let points: MapPoint[];
  try {
    points = await listMapPoints();
  } catch (error) {
    console.error("Map failed:", error instanceof Error ? error.message.slice(0, 200) : "unknown error");
    return (
      <>
        <PageHeader title="Map" />
        <ErrorPanel title="The database couldn't load your offers">Reload the page in a minute.</ErrorPanel>
      </>
    );
  }
  const placed = place(points);
  const noDate = placed.filter((p) => p.days === null).length;

  return (
    <>
      <PageHeader title="Map" lead="Every open offer by how soon it's due and what it pays. Top left needs you first." />
      {placed.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-8 text-muted">
          Open offers appear here as dots once Spotlight finds them in the inbox: further left means due sooner, higher up means better paid.
        </p>
      ) : (
        <>
          <figure className="overflow-x-auto rounded-[28px] border border-line bg-surface p-3 md:p-5">
            <svg role="img" aria-labelledby="map-title" viewBox="0 0 1000 560" className="block h-auto min-w-[720px] w-full">
              <title id="map-title">{`${placed.length} open offers by days left and fee`}</title>
              {/* Quadrants */}
              <rect x={L} y={T} width={(R - L) / 4} height={B - T} fill="var(--color-gel)" opacity="0.07" />
              <text x={L + 12} y={T + 22} fontSize="14" fill="var(--color-gel)" fontWeight="600">
                Soon and well paid: answer first
              </text>
              <text x={R - 12} y={T + 22} fontSize="14" fill="var(--color-muted)" textAnchor="end">
                Well paid, time to think
              </text>
              <text x={L + 12} y={B - 12} fontSize="14" fill="var(--color-muted)">
                Due soon, small fee
              </text>
              <text x={R - 12} y={B - 12} fontSize="14" fill="var(--color-muted)" textAnchor="end">
                Can wait
              </text>
              {/* Fee grid */}
              {[25_000, 100_000, 200_000, 300_000].map((f) => (
                <g key={f}>
                  <line x1={L} x2={R} y1={feeY(f)} y2={feeY(f)} stroke="var(--color-line)" strokeDasharray="3 6" />
                  <text x={L - 10} y={feeY(f) + 4} fontSize="12" fill="var(--color-muted)" textAnchor="end">
                    {f >= 100_000 ? `₹${f / 100_000}L${f === MAX_FEE ? "+" : ""}` : `₹${f / 1000}k`}
                  </text>
                </g>
              ))}
              {/* Day grid */}
              {[0, 7, 14, 30, 60].map((d) => (
                <g key={d}>
                  <line x1={dayX(d)} x2={dayX(d)} y1={T} y2={BAND_B} stroke="var(--color-line)" strokeDasharray={d === 0 ? undefined : "3 6"} />
                  <text x={dayX(d)} y={BAND_B + 22} fontSize="12" fill="var(--color-muted)" textAnchor="middle">
                    {d === 0 ? "Today" : d === 60 ? "60+ days / no date" : `${d} days`}
                  </text>
                </g>
              ))}
              <rect x={L} y={BAND_T} width={R - L} height={BAND_B - BAND_T} rx="10" fill="var(--color-raised)" />
              <text x={L - 10} y={BAND_T + 34} fontSize="12" fill="var(--color-muted)" textAnchor="end">
                No fee
              </text>
              {/* Offers */}
              {placed.map((p) => (
                <a key={p.id} href={`/opportunities/${p.id}`}>
                  <title>{`${p.title} · ${payText(p)}${p.next_deadline_at ? ` · ${formatDay(p.next_deadline_at)}` : ""}`}</title>
                  {p.priority === "high" && <circle cx={p.x} cy={p.y} r={RADIUS.high + 9} fill="var(--color-gel)" opacity="0.18" />}
                  <circle cx={p.x} cy={p.y} r={RADIUS[p.priority]} fill={COLOR[p.priority]} stroke="var(--color-surface)" strokeWidth="2" />
                  <text
                    x={p.x > R - 160 ? p.x - RADIUS[p.priority] - 6 : p.x + RADIUS[p.priority] + 6}
                    y={p.y + 4}
                    fontSize="13"
                    fill="var(--color-ink)"
                    textAnchor={p.x > R - 160 ? "end" : "start"}
                  >
                    {truncate(p.organization ?? p.title, 22)}
                  </text>
                </a>
              ))}
            </svg>
            <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-2 px-2 text-sm text-muted">
              {(Object.keys(LABEL) as MapPoint["priority"][]).map((k) => (
                <span key={k} className="flex items-center gap-2">
                  <span aria-hidden="true" className="inline-block rounded-full" style={{ width: RADIUS[k] + 4, height: RADIUS[k] + 4, background: COLOR[k] }} />
                  {LABEL[k]}
                </span>
              ))}
              {noDate > 0 && <span>{`${noDate} without a date sit on the right edge.`}</span>}
              <span>Fees in other currencies sit in the no-fee band.</span>
            </figcaption>
          </figure>

          <section aria-labelledby="h-list" className="mt-10">
            <h2 id="h-list" className="font-display text-2xl font-semibold">
              Every dot, as a list
            </h2>
            <ul className="mt-4 divide-y divide-line rounded-2xl border border-line bg-surface">
              {placed.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                  <span className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: COLOR[p.priority] }} />
                    <span className="min-w-0">
                      <Link href={`/opportunities/${p.id}`} className="font-medium underline-offset-4 hover:underline">
                        {p.title}
                      </Link>
                      <span className="block truncate text-sm text-muted">{[p.organization, LABEL[p.priority]].filter(Boolean).join(" · ")}</span>
                    </span>
                  </span>
                  <span className="text-right text-sm tabular-nums">
                    <span className="block font-semibold">{payText(p)}</span>
                    <span className="text-muted">{p.next_deadline_at ? formatDay(p.next_deadline_at) : "No date"}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
