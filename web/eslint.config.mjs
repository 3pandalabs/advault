import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output from @opennextjs/cloudflare. Not in eslint-config-next's
    // defaults, so without this `npm run lint` reports thousands of findings in
    // generated bundles and buries the handful in src/.
    ".open-next/**",
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
