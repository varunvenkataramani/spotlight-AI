"use client";

// Turns notifications on or off for this phone or browser. The only client code in Spotlight:
// asking for permission and subscribing can only happen in the browser.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type State = "checking" | "unsupported" | "iphone_needs_home_screen" | "blocked" | "off" | "on" | "working";

const toBytes = (b64url: string) => {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function post(body: object): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return { ok: res.ok, message: data.message ?? data.error ?? "Something went wrong. Try again." };
}

export function PushToggle({ publicKey }: { publicKey: string | null }) {
  const router = useRouter();
  const [state, setState] = useState<State>("checking");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !publicKey) {
        return setState(iphone && !standalone ? "iphone_needs_home_screen" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("blocked");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.getSubscription();
      setState(sub && sameKey(sub.options.applicationServerKey, toBytes(publicKey)) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, [publicKey]);

  async function turnOn() {
    if (!publicKey) return;
    setState("working");
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe(); // it may belong to an older server key
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
      const r = await post({ action: "subscribe", subscription: sub.toJSON() });
      if (!r.ok) await sub.unsubscribe();
      setState(r.ok ? "on" : "off");
      setMessage(r.message);
      router.refresh();
    } catch {
      setState("off");
      setMessage("This browser couldn't turn on notifications. Try again, or use Telegram.");
    }
  }

  async function turnOff() {
    setState("working");
    setMessage(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await post({ action: "unsubscribe", endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setState("off");
      setMessage("Notifications are off for this device.");
      router.refresh();
    } catch {
      setState("on");
      setMessage("Couldn't turn them off. Try again.");
    }
  }

  const button = "rounded-full px-4 py-2 text-sm font-semibold";
  return (
    <div className="space-y-2">
      {state === "checking" && <p className="text-sm text-muted">Checking this device…</p>}
      {state === "unsupported" && <p className="text-sm text-muted">This browser can't show notifications. Use Telegram, or try Chrome or Safari.</p>}
      {state === "iphone_needs_home_screen" && (
        <p className="text-sm leading-relaxed text-muted">
          On iPhone: tap the Share button in Safari, choose <b>Add to Home Screen</b>, then open Spotlight from the new icon and come back here.
        </p>
      )}
      {state === "blocked" && (
        <p className="text-sm leading-relaxed text-muted">Notifications are blocked for this site. Allow them in the browser's site settings, then reload.</p>
      )}
      {(state === "off" || state === "on" || state === "working") && (
        <div className="flex flex-wrap items-center gap-3">
          {state === "on" ? (
            <>
              <span className="text-sm font-medium text-ok">On for this device</span>
              <button type="button" onClick={turnOff} className={`${button} border border-line bg-surface font-medium hover:border-ink/30`}>
                Turn off
              </button>
            </>
          ) : (
            <button type="button" onClick={turnOn} disabled={state === "working"} className={`${button} bg-ink text-paper hover:bg-ink-soft disabled:opacity-60`}>
              {state === "working" ? "Working…" : "Turn on for this device"}
            </button>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
      )}
    </div>
  );
}
