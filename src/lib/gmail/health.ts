// Is the inbox actually being read? Plain rules over the stored sync state, shared by the
// banner on every page, the alerts, and the public health check.

/** While the Google app is in Testing mode, Google ends Spotlight's access this long after each grant. */
export const TESTING_ACCESS_MS = 7 * 86_400_000;
/** How far ahead of that to warn. */
export const EXPIRY_WARNING_MS = 86_400_000;
/** The scheduler reads mail every minute; this long without a successful read means something is wrong. */
export const STALL_AFTER_MS = 20 * 60_000;

export type InboxHealthInput = {
  status: string;
  last_synced_at: Date | null;
  consecutive_failures: number;
  authorized_at: Date | null;
  connected_at: Date;
};

export type InboxHealth =
  | { state: "ok" }
  /** Still working, but Google's weekly limit ends it soon. */
  | { state: "expiring"; endsAt: Date }
  /** Connected, but reads keep failing or haven't happened for a while. */
  | { state: "stalled"; since: Date }
  /** Google stopped accepting Spotlight's access: someone has to reconnect. */
  | { state: "needs_reconnect"; since: Date | null };

export function inboxHealth(r: InboxHealthInput, now: Date = new Date()): InboxHealth {
  if (r.status === "needs_reconnect" || r.status === "revoked" || r.status === "error") return { state: "needs_reconnect", since: r.last_synced_at };
  if (r.status !== "connected") return { state: "ok" };

  const lastGood = r.last_synced_at ?? r.connected_at;
  if (r.consecutive_failures >= 3 || now.getTime() - lastGood.getTime() > STALL_AFTER_MS) return { state: "stalled", since: lastGood };

  // Only in the last day before the weekly limit. An inbox still working after 7 days evidently
  // isn't under that limit (the Google app was published), so it never warns again.
  const granted = r.authorized_at ?? r.connected_at;
  const endsAt = new Date(granted.getTime() + TESTING_ACCESS_MS);
  const left = endsAt.getTime() - now.getTime();
  if (left > 0 && left <= EXPIRY_WARNING_MS) return { state: "expiring", endsAt };
  return { state: "ok" };
}
