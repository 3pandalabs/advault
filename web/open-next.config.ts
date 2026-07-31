// No proxy.ts / middleware in this app — see CLAUDE.md. The adapter cannot
// bundle Next.js middleware (it pulls in Node-only `async_hooks`), and the
// dashboard's auth check lives in its layout, with the API's requireAuth as the
// real boundary.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
