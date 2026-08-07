import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Bind all interfaces so the page is reachable from another machine on the
    // LAN — the whole point of a 2D playable build is getting friends into it.
    host: true,
  },
  build: { target: "es2022" },
});
