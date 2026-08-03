import { defineConfig } from "vitest/config";

// The source is ESM with explicit `.js` specifiers, which is what Node needs at
// runtime but not what Vite resolves — it would look for a literal `policy.js`
// next to `policy.ts` and fail. Rewriting relative `.js` specifiers to
// extensionless lets Vite resolve the TypeScript source without changing a
// single import in the app.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
});
