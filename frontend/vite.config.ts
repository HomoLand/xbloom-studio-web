import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages project site: https://homoland.github.io/xbloom-studio-web/
const pagesBase = process.env.VITE_BASE || "/";

export default defineConfig({
  base: pagesBase,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },
});

