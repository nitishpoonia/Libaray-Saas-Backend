import { defineConfig } from "tsup";

// Bundles the TypeScript source into dist/ for production. Dependencies in
// package.json stay external and are loaded from node_modules at runtime.
export default defineConfig({
  entry: { server: "src/server.ts", "jobs/daily": "src/jobs/daily.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  clean: true,
});
