import type { MetadataRoute } from "next";

// Lets Spotlight be added to a phone's home screen. On iPhone this is required before
// it can show notifications.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Spotlight",
    short_name: "Spotlight",
    description: "Private opportunity console.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0e0d14",
    theme_color: "#0e0d14",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
