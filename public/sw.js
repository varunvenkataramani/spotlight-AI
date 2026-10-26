// Spotlight's service worker: shows alerts sent to this phone or browser, and opens the right
// page when one is tapped. It doesn't cache pages, so nothing private is stored on the device.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(typeof data.title === "string" ? data.title : "Spotlight", {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = new URL("/", self.location.origin);
  try {
    const u = new URL(event.notification.data?.url || "/", self.location.origin);
    if (u.origin === self.location.origin) target = u; // only ever open Spotlight's own pages
  } catch {}
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url.startsWith(self.location.origin) && "focus" in w) {
          return w.navigate(target.href).then((c) => (c ?? w).focus());
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
