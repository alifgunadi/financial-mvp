import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Minimal config. API URL is read at runtime via import.meta.env.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 7364,
  },
  preview: {
    host: "0.0.0.0",
    port: 7364,
  },
});
