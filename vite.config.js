import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/goldcalc/",
  plugins: [react()],
  server: {
    proxy: {
      "/api/goldprice": {
        target: "https://data-asg.goldprice.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/goldprice/, "/dbXRates"),
      },
    },
  },
});
